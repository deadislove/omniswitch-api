import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  UseGuards,
  UseInterceptors,
  Sse,
  MessageEvent,
  Req,
  HttpCode,
  HttpStatus,
  UploadedFile,
  Logger,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiHeader, ApiResponse } from '@nestjs/swagger';
import { Observable, Subject, fromEvent } from 'rxjs';
import { map, filter } from 'rxjs/operators';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID as uuidv4 } from 'crypto';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../shared/guards/roles.guard';
import { HmacSignatureGuard } from '../../../../shared/guards/hmac-signature.guard';
import { MerchantThrottlerGuard } from '../../../../shared/guards/merchant-throttler.guard';
import { Roles, UserRole } from '../../../../shared/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../interceptors/idempotency.interceptor';
import { PaymentCheckoutSaga } from '../sagas/payment-checkout.saga';
import {
  ChargePaymentDto,
  ChargePaymentResponseDto,
  PaymentDetailResponseDto,
  RefundPaymentResponseDto,
  CapturePaymentResponseDto,
  CancelPaymentResponseDto,
  BulkUploadResponseDto,
} from '../dto/charge-payment.dto';
import { RefundPaymentDto, CapturePaymentDto } from '../dto/refund-payment.dto';
import { Money } from '../../domain/value-objects/money.vo';
import { BinInfo } from '../../domain/value-objects/bin-info.vo';
import { PaymentRepositoryPort } from '../../ports/outbound/payment-repository.port';
import { AcquirerRoutingService } from '../services/acquirer-routing.service';
import { PaymentLifecycleService } from '../services/payment-lifecycle.service';
import { PaymentAggregate } from '../../domain/aggregates/payment.aggregate';
import { PaymentStatus } from '../../domain/value-objects/payment-status.vo';
import { FXRateProviderPort } from '../../ports/outbound/fx-rate-provider.port';
import { DelegationService } from '../services/delegation.service';
import * as csv from 'csv-parser';
import { Readable } from 'stream';

// @Throttle's arguments are evaluated once, at class-definition time (a
// plain decorator, not DI-resolved) — this can't go through ConfigService,
// which only exists once Nest's runtime container is up. Reading directly
// from process.env keeps the production default (100/min) unchanged while
// letting e2e (test/setup-env.ts) and load-test (docker-compose.yml) runs
// raise it: this route's cap is IP-scoped as well as merchant-scoped (see
// MerchantThrottlerGuard's docblock), so every request in a single-machine
// e2e/load-test run — regardless of which merchant it authenticates as —
// competes for the same 100/min budget. See docs/technical/load-testing.md,
// Finding #1, for how this was first found to be the actual ceiling.
const CHARGE_RATE_LIMIT_MAX = Number(process.env.CHARGE_RATE_LIMIT_MAX) || 100;
const CHARGE_RATE_LIMIT_TTL = Number(process.env.CHARGE_RATE_LIMIT_TTL) || 60000;

/**
 * Payment Controller (v1)
 * Handles all payment-related HTTP endpoints.
 *
 * Security layers:
 * - JWT Authentication (JwtAuthGuard)
 * - RBAC (RolesGuard)
 * - HMAC Signature Verification (HmacSignatureGuard)
 * - Idempotency (IdempotencyInterceptor)
 * - Rate Limiting (Throttle)
 */
@ApiTags('Payments v1')
@ApiBearerAuth()
@Controller('payments')
// MerchantThrottlerGuard must come after JwtAuthGuard — Nest runs guards in
// array order, and it needs req.user (set by JwtAuthGuard) to key the quota
// by merchant instead of falling back to IP.
@UseGuards(JwtAuthGuard, RolesGuard, MerchantThrottlerGuard)
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly checkoutSaga: PaymentCheckoutSaga,
    private readonly paymentRepository: PaymentRepositoryPort,
    private readonly acquirerRouting: AcquirerRoutingService,
    private readonly eventEmitter: EventEmitter2,
    private readonly paymentLifecycle: PaymentLifecycleService,
    private readonly fxRateProvider: FXRateProviderPort,
    private readonly delegationService: DelegationService,
  ) {}

  /** Merchants may only act on their own payments; ADMIN/OPERATOR may act on any. */
  private assertOwnership(payment: PaymentAggregate, req: any): void {
    if (req.user?.roles?.includes(UserRole.MERCHANT) && payment.metadata.merchantId !== req.user.merchantId) {
      // BadRequestException always sends HTTP 400 regardless of the
      // statusCode field inside its body — a client checking the actual
      // response status (not just the JSON payload) would never see this as
      // a 403. Verified live: a cross-merchant cancel attempt came back as
      // HTTP 400 with a body claiming "statusCode":403.
      throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'ACCESS_DENIED' });
    }
  }

  /**
   * POST /api/v1/payments/charge
   * Initiates a payment charge with smart PSP routing.
   * Requires: JWT Auth + HMAC Signature + Idempotency-Key — except an
   * AGENT-authenticated caller (a Delegation's own token, see
   * DelegationController), which is exempt from the HMAC requirement (see
   * HmacSignatureGuard's docblock) but instead has its charge amount/
   * category checked against, and reserved from, its delegation's spend
   * policy before the saga ever runs.
   */
  @Post('charge')
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN, UserRole.AGENT)
  @UseGuards(HmacSignatureGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: CHARGE_RATE_LIMIT_MAX, ttl: CHARGE_RATE_LIMIT_TTL } })
  @ApiOperation({ summary: 'Charge a payment with smart PSP routing — also usable by an AGENT token (see POST /delegations), whose charge is checked against its delegation\'s spend policy instead of requiring HMAC signature headers' })
  @ApiResponse({ status: 201, type: ChargePaymentResponseDto })
  @ApiResponse({ status: 400, description: 'Missing Idempotency-Key header' })
  @ApiResponse({ status: 403, description: 'The caller\'s Delegation has been revoked' })
  @ApiResponse({ status: 409, description: 'splits requested with captureMethod "manual", or a split recipient has an incompatible settlement-currency conversion' })
  @ApiResponse({ status: 422, description: 'Card reference looks like a raw card number, the request body fails validation, a split recipient is not a valid connected account / the split total exceeds the net payout, or (AGENT callers only) the charge violates the delegation\'s spend policy (per-transaction/monthly limit, disallowed category, currency mismatch)' })
  @ApiHeader({ name: 'Idempotency-Key', description: 'UUID v4 for idempotent requests', required: true })
  @ApiHeader({ name: 'X-Signature', description: 'HMAC-SHA256 signature (not required for an AGENT-authenticated call)', required: false })
  @ApiHeader({ name: 'X-Timestamp', description: 'Unix timestamp (not required for an AGENT-authenticated call)', required: false })
  @ApiHeader({ name: 'X-Merchant-Id', description: 'Merchant identifier (not required for an AGENT-authenticated call)', required: false })
  async charge(
    @Body() dto: ChargePaymentDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() req: any,
  ): Promise<ChargePaymentResponseDto> {
    const paymentId = uuidv4();
    const merchantId = req.user?.merchantId;

    if (!idempotencyKey) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Idempotency-Key header is required',
        code: 'MISSING_IDEMPOTENCY_KEY',
      });
    }

    this.logger.log(
      `Charge request: paymentId=${paymentId}, merchant=${merchantId}, ` +
      `amount=${dto.amount} ${dto.currency}, idempotencyKey=${idempotencyKey}`,
    );

    const amount = Money.of(dto.amount, dto.currency);

    // A manual-capture (REQUIRES_CAPTURE) charge doesn't book any ledger
    // entries until a later, separate POST /:id/capture call —
    // PaymentLifecycleService.capture() doesn't accept splits, so a split
    // requested here would silently be dropped rather than routed to the
    // connected merchant at capture time. Reject up front instead.
    if (dto.splits && dto.splits.length > 0 && dto.captureMethod === 'manual') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Marketplace splits require captureMethod "automatic" (the default) — a manual capture cannot be split',
        code: 'SPLIT_REQUIRES_AUTOMATIC_CAPTURE',
      });
    }
    const splits = dto.splits?.map((s) => ({ merchantId: s.merchantId, amount: Money.of(s.amount, dto.currency) }));

    let binInfo: BinInfo | undefined;
    if (dto.binInfo) {
      binInfo = new BinInfo({
        bin: dto.binInfo.bin,
        country: dto.binInfo.country,
        cardBrand: dto.binInfo.cardBrand,
        cardType: dto.binInfo.cardType,
        issuingBank: dto.binInfo.issuingBank,
      });
    }

    // Presentment currency: what the customer's own statement will show,
    // if different from the currency actually charged/settled (`currency`
    // above — this never changes what's captured or how the merchant is
    // paid out, purely informational). Computed best-effort and never
    // blocks the real charge — a failed FX lookup here just means the
    // response omits presentmentAmount, not that the charge fails.
    // Deliberately not persisted (see docs/business-domain/
    // ledger-and-settlement.md's Cross-Border Settlement section) — there
    // is no audit trail reconstructing "what rate did we show this
    // customer" after this response is gone.
    let presentment: { amount: number; currency: string; rate: number; provider: string } | undefined;
    if (dto.presentmentCurrency && dto.presentmentCurrency.toUpperCase() !== dto.currency.toUpperCase()) {
      try {
        const { rate, provider } = await this.fxRateProvider.getRate(dto.currency, dto.presentmentCurrency);
        const converted = amount.convertTo(dto.presentmentCurrency, rate, provider);
        presentment = { amount: converted.amount, currency: converted.currency.code, rate, provider };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Presentment currency conversion to ${dto.presentmentCurrency} failed for payment ${paymentId}, omitting from response: ${msg}`);
      }
    }

    // An AGENT-authenticated caller (see delegation.aggregate.ts) is
    // charging under a spend policy, not the merchant's own unrestricted
    // authority — reserve the amount against it *before* the saga ever
    // calls a PSP, the same "validate/reserve before money moves, there's
    // no undo for a completed charge" principle
    // ChargeLedgerParamsResolverService's split validation already follows.
    // A reservation that survives to a SUCCEEDED/REQUIRES_ACTION/
    // REQUIRES_CAPTURE outcome stays booked; only a definite FAILED result
    // (or the saga throwing) releases it below.
    let reservedDelegationId: string | undefined;
    if (req.user?.roles?.includes(UserRole.AGENT)) {
      const delegationId = req.user?.delegationId;
      if (!delegationId) {
        throw new ForbiddenException({ statusCode: 403, error: 'Agent token is missing its delegation reference', code: 'DELEGATION_MISSING' });
      }
      await this.delegationService.reserveSpendOrThrow(delegationId, amount, dto.category, new Date());
      reservedDelegationId = delegationId;
    }

    let result;
    try {
      result = await this.checkoutSaga.execute({
        paymentId,
        idempotencyKey,
        amount,
        merchantId,
        customerId: dto.customerId,
        orderId: dto.orderId,
        description: dto.description,
        binInfo,
        paymentMethodId: dto.paymentMethodId,
        cardToken: dto.cardToken,
        preferredProvider: dto.preferredProvider,
        captureMethod: dto.captureMethod,
        splits,
        initiatorMetadata: reservedDelegationId ? { delegationId: reservedDelegationId, initiatedBy: 'agent' } : undefined,
      });
    } catch (err: unknown) {
      if (reservedDelegationId) {
        await this.delegationService.releaseReservation(reservedDelegationId, amount);
      }
      throw err;
    }

    if (reservedDelegationId && result.status === PaymentStatus.FAILED) {
      await this.delegationService.releaseReservation(reservedDelegationId, amount);
    }

    return {
      paymentId: result.paymentId,
      status: result.status,
      pspTransactionId: result.pspTransactionId,
      pspProvider: result.pspProvider,
      actionUrl: result.actionUrl,
      requiresAction: result.requiresAction,
      riskScore: result.riskScore,
      usedFallback: result.usedFallback,
      estimatedFee: result.estimatedFee
        ? { amount: result.estimatedFee.amount, currency: result.estimatedFee.currency.code }
        : undefined,
      presentmentAmount: presentment?.amount,
      presentmentCurrency: presentment?.currency,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * GET /api/v1/payments/:id/status/stream
   * Server-Sent Events (SSE) stream for real-time payment status updates.
   */
  @Sse(':id/status/stream')
  @Roles(UserRole.MERCHANT, UserRole.ADMIN, UserRole.READONLY)
  @ApiOperation({ summary: 'SSE stream for real-time payment status updates' })
  @ApiResponse({ status: 200, description: 'text/event-stream — not representable as a JSON schema; each event is a payment.status.* domain event serialized as { paymentId, status, timestamp, type }' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async streamPaymentStatus(
    @Param('id') paymentId: string,
    @Req() req: any,
  ): Promise<Observable<MessageEvent>> {
    // Unlike getPayment(), this endpoint previously had no ownership check at
    // all: any authenticated MERCHANT/READONLY user could subscribe to any
    // other merchant's payment stream (status, risk score, PSP transaction
    // id) just by knowing/guessing the payment UUID. Enforce the same
    // merchant-scoping rule here before opening the stream.
    const payment = await this.paymentRepository.findById(paymentId);
    if (!payment) {
      throw new NotFoundException({ statusCode: 404, error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
    }
    this.assertOwnership(payment, req);

    this.logger.log(`SSE stream opened for payment ${paymentId}`);

    return new Observable<MessageEvent>((subscriber) => {
      // Send initial status (already fetched + authorized above)
      subscriber.next({
        data: JSON.stringify({
          paymentId,
          status: payment.status,
          timestamp: new Date().toISOString(),
          type: 'status_update',
        }),
        type: 'payment.status',
        id: uuidv4(),
      } as MessageEvent);

      // Listen for domain events
      const handler = (event: any) => {
        if (event.paymentId === paymentId || event.aggregateId === paymentId) {
          subscriber.next({
            data: JSON.stringify({
              paymentId,
              eventName: event.eventName,
              status: event.newStatus || event.status,
              timestamp: event.occurredAt?.toISOString() || new Date().toISOString(),
              type: 'status_update',
              metadata: event.metadata,
            }),
            type: event.eventName,
            id: event.eventId || uuidv4(),
          } as MessageEvent);

          // Close stream on terminal states
          if (['payment.charged', 'payment.failed', 'payment.refunded'].includes(event.eventName)) {
            setTimeout(() => subscriber.complete(), 1000);
          }
        }
      };

      this.eventEmitter.on('payment.status.changed', handler);
      this.eventEmitter.on('payment.charged', handler);
      this.eventEmitter.on('payment.failed', handler);
      this.eventEmitter.on('payment.refunded', handler);
      this.eventEmitter.on('payment.requires_action', handler);

      // Heartbeat every 30 seconds
      const heartbeat = setInterval(() => {
        subscriber.next({
          data: JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() }),
          type: 'heartbeat',
        } as MessageEvent);
      }, 30000);

      // Cleanup on unsubscribe
      return () => {
        clearInterval(heartbeat);
        this.eventEmitter.off('payment.status.changed', handler);
        this.eventEmitter.off('payment.charged', handler);
        this.eventEmitter.off('payment.failed', handler);
        this.eventEmitter.off('payment.refunded', handler);
        this.eventEmitter.off('payment.requires_action', handler);
        this.logger.log(`SSE stream closed for payment ${paymentId}`);
      };
    });
  }

  /**
   * GET /api/v1/payments/:id
   * Retrieve payment details by ID.
   */
  @Get(':id')
  @Roles(UserRole.MERCHANT, UserRole.ADMIN, UserRole.READONLY)
  @ApiOperation({ summary: 'Get payment details by ID' })
  @ApiResponse({ status: 200, type: PaymentDetailResponseDto })
  @ApiResponse({ status: 403, description: 'This payment belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async getPayment(@Param('id') id: string, @Req() req: any): Promise<PaymentDetailResponseDto> {
    const payment = await this.paymentRepository.findById(id);
    if (!payment) {
      throw new NotFoundException({ statusCode: 404, error: 'Payment not found', code: 'PAYMENT_NOT_FOUND' });
    }

    this.assertOwnership(payment, req);

    return {
      paymentId: payment.id,
      status: payment.status,
      amount: payment.amount.amount,
      currency: payment.amount.currency.code,
      pspProvider: payment.pspProvider,
      pspTransactionId: payment.pspTransactionId,
      riskScore: payment.riskScore,
      refunds: payment.refunds.map((r) => ({
        refundId: r.refundId,
        amount: r.amount.amount,
        currency: r.amount.currency.code,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      })),
      captures: payment.captures.map((c) => ({
        captureId: c.captureId,
        amount: c.amount.amount,
        createdAt: c.createdAt.toISOString(),
      })),
      createdAt: payment.createdAt.toISOString(),
      updatedAt: payment.updatedAt.toISOString(),
    };
  }

  /**
   * POST /api/v1/payments/:id/refund
   * Full or partial refund of a SUCCEEDED/PARTIALLY_REFUNDED payment.
   */
  @Post(':id/refund')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @UseGuards(HmacSignatureGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Refund a payment (full or partial)' })
  @ApiHeader({ name: 'Idempotency-Key', description: 'UUID v4 for idempotent requests', required: true })
  @ApiResponse({ status: 200, type: RefundPaymentResponseDto })
  @ApiResponse({ status: 400, description: 'Missing Idempotency-Key header' })
  @ApiResponse({ status: 403, description: 'This payment belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  @ApiResponse({ status: 409, description: 'Refund amount exceeds the remaining refundable balance, or the payment is not in a refundable status' })
  @ApiResponse({ status: 422, description: 'PSP declined the refund' })
  async refundPayment(
    @Param('id') id: string,
    @Body() dto: RefundPaymentDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() req: any,
  ): Promise<RefundPaymentResponseDto> {
    if (!idempotencyKey) {
      throw new BadRequestException({ statusCode: 400, error: 'Idempotency-Key header is required', code: 'MISSING_IDEMPOTENCY_KEY' });
    }
    const payment = await this.paymentLifecycle.getOwnedPayment(id);
    this.assertOwnership(payment, req);

    const updated = await this.paymentLifecycle.refund({
      payment,
      amount: dto.amount,
      reason: dto.reason,
      idempotencyKey,
    });

    return {
      paymentId: updated.id,
      status: updated.status,
      totalRefunded: updated.totalRefunded.amount,
      remainingRefundable: updated.remainingRefundable.amount,
      currency: updated.amount.currency.code,
      refunds: updated.refunds.map((r) => ({
        refundId: r.refundId,
        amount: r.amount.amount,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /**
   * POST /api/v1/payments/:id/capture
   * Captures funds for a payment authorized with captureMethod: 'manual'.
   */
  @Post(':id/capture')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @UseGuards(HmacSignatureGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Capture a previously authorized (REQUIRES_CAPTURE) payment' })
  @ApiHeader({ name: 'Idempotency-Key', description: 'UUID v4 for idempotent requests', required: true })
  @ApiResponse({ status: 200, type: CapturePaymentResponseDto })
  @ApiResponse({ status: 400, description: 'Missing Idempotency-Key header' })
  @ApiResponse({ status: 403, description: 'This payment belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  @ApiResponse({ status: 409, description: 'Payment is not REQUIRES_CAPTURE/PARTIALLY_CAPTURED, or the capture amount exceeds the remaining authorized amount' })
  @ApiResponse({ status: 422, description: 'PSP declined the capture' })
  async capturePayment(
    @Param('id') id: string,
    @Body() dto: CapturePaymentDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() req: any,
  ): Promise<CapturePaymentResponseDto> {
    if (!idempotencyKey) {
      throw new BadRequestException({ statusCode: 400, error: 'Idempotency-Key header is required', code: 'MISSING_IDEMPOTENCY_KEY' });
    }
    const payment = await this.paymentLifecycle.getOwnedPayment(id);
    this.assertOwnership(payment, req);

    const updated = await this.paymentLifecycle.capture({
      payment,
      amount: dto.amount,
      idempotencyKey,
    });

    return {
      paymentId: updated.id,
      status: updated.status,
      pspTransactionId: updated.pspTransactionId,
      amount: updated.amount.amount,
      totalCaptured: updated.totalCaptured.amount,
      remainingCapturable: updated.remainingCapturable.amount,
      currency: updated.amount.currency.code,
      captures: updated.captures.map((c) => ({
        captureId: c.captureId,
        amount: c.amount.amount,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  /**
   * POST /api/v1/payments/:id/cancel
   * Cancels a payment that hasn't been captured yet.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @UseGuards(HmacSignatureGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @ApiOperation({ summary: 'Cancel a payment before capture' })
  @ApiHeader({ name: 'Idempotency-Key', description: 'UUID v4 for idempotent requests', required: true })
  @ApiResponse({ status: 200, type: CancelPaymentResponseDto, description: 'Also returned on a repeat call against an already-CANCELLED payment — cancel is idempotent' })
  @ApiResponse({ status: 400, description: 'Missing Idempotency-Key header' })
  @ApiResponse({ status: 403, description: 'This payment belongs to a different merchant' })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  @ApiResponse({ status: 409, description: 'Payment is not in a cancellable status (e.g. already captured)' })
  @ApiResponse({ status: 422, description: 'PSP declined the cancellation' })
  async cancelPayment(
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() req: any,
  ): Promise<CancelPaymentResponseDto> {
    if (!idempotencyKey) {
      throw new BadRequestException({ statusCode: 400, error: 'Idempotency-Key header is required', code: 'MISSING_IDEMPOTENCY_KEY' });
    }
    const payment = await this.paymentLifecycle.getOwnedPayment(id);
    this.assertOwnership(payment, req);

    const updated = await this.paymentLifecycle.cancel({ payment, idempotencyKey });

    return {
      paymentId: updated.id,
      status: updated.status,
    };
  }

  /**
   * POST /api/v1/payments/bulk-upload
   * Bulk invoice batch processing via multipart/form-data CSV upload.
   * Streams CSV rows and processes each payment asynchronously.
   */
  @Post('bulk-upload')
  @Roles(UserRole.MERCHANT, UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', {
    // FileInterceptor has no size limit by default, so an unbounded upload
    // is buffered entirely into memory (MemoryStorage) — a single request
    // could exhaust process memory. Cap it well above any real CSV batch.
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Bulk invoice upload for batch payment processing' })
  @ApiResponse({ status: 201, type: BulkUploadResponseDto, description: 'Rows are queued, not charged synchronously — a 201 here means parsing succeeded, not that every payment succeeded' })
  @ApiResponse({ status: 400, description: 'No file was attached' })
  async bulkUpload(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ): Promise<BulkUploadResponseDto> {
    if (!file) {
      throw new BadRequestException('CSV file is required');
    }

    const merchantId = req.user?.merchantId;
    const results: any[] = [];
    const errors: any[] = [];

    // Stream CSV parsing
    await new Promise<void>((resolve, reject) => {
      const stream = Readable.from(file.buffer);
      stream
        .pipe(csv())
        .on('data', async (row: any) => {
          try {
            const amount = Money.of(parseFloat(row.amount), row.currency || 'USD');
            const paymentId = uuidv4();
            const idempotencyKey = row.idempotency_key || uuidv4();

            // Queue for async processing (in production: push to message queue)
            results.push({
              rowIndex: results.length + errors.length,
              paymentId,
              orderId: row.order_id,
              amount: amount.amount,
              currency: amount.currency.code,
              status: 'QUEUED',
              idempotencyKey,
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            errors.push({ row, error: msg });
          }
        })
        .on('end', resolve)
        .on('error', reject);
    });

    this.logger.log(
      `Bulk upload: merchant=${merchantId}, queued=${results.length}, errors=${errors.length}`,
    );

    return {
      totalRows: results.length + errors.length,
      queued: results.length,
      failed: errors.length,
      payments: results,
      errors: errors.slice(0, 10), // Return first 10 errors
      batchId: uuidv4(),
      processedAt: new Date().toISOString(),
    };
  }

  /**
   * GET /api/v1/payments/routing/health
   * Get PSP routing health status.
   */
  @Get('routing/health')
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  @ApiOperation({ summary: 'Get PSP routing health status' })
  @ApiResponse({
    status: 200,
    description: 'Keyed by PSP provider name (e.g. "STRIPE", "ADYEN") — the key set depends on which adapters are configured, so this is documented as a free-form map rather than a fixed schema',
    schema: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          available: { type: 'boolean' },
          circuitBreaker: { type: 'string', enum: ['CLOSED', 'HALF_OPEN', 'OPEN'] },
          successRate: { type: 'string', example: '98%' },
          avgLatency: { type: 'string', example: '120ms' },
          fee: { type: 'string', example: '2.9% + 30 minor units' },
        },
      },
    },
  })
  async getRoutingHealth(): Promise<Record<string, unknown>> {
    return this.acquirerRouting.getPSPHealthSummary();
  }
}
