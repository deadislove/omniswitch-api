import { AmlReviewMonitoringService } from './aml-review-monitoring.service';

const createMerchant = (overrides: Record<string, unknown> = {}) => ({
  merchantId: 'merchant_high_risk',
  industryRiskCategory: 'HIGH',
  amlReviewAutoManaged: true,
  amlReviewFlagged: false,
  amlReviewFlagReason: undefined,
  ...overrides,
});

describe('AmlReviewMonitoringService.evaluate()', () => {
  let paymentRepository: any;
  let merchantService: any;
  let notificationDispatcher: any;
  let service: AmlReviewMonitoringService;

  beforeEach(() => {
    paymentRepository = { countHardDeclinesSince: jest.fn() };
    merchantService = {
      findByMerchantId: jest.fn(),
      applyAutoAmlReviewFlag: jest.fn().mockResolvedValue(undefined),
    };
    notificationDispatcher = { notify: jest.fn().mockResolvedValue(undefined) };
    service = new AmlReviewMonitoringService(paymentRepository, merchantService, notificationDispatcher);
  });

  it('does nothing when the decline is not a hard decline', async () => {
    await service.evaluate('merchant_high_risk', 'insufficient_funds', 'STRIPE');
    expect(merchantService.findByMerchantId).not.toHaveBeenCalled();
  });

  it('does nothing for a non-HIGH-industry merchant, even with a hard decline', async () => {
    merchantService.findByMerchantId.mockResolvedValue(createMerchant({ industryRiskCategory: 'LOW' }));
    await service.evaluate('merchant_high_risk', 'stolen_card', 'STRIPE');
    expect(paymentRepository.countHardDeclinesSince).not.toHaveBeenCalled();
    expect(merchantService.applyAutoAmlReviewFlag).not.toHaveBeenCalled();
  });

  it('does nothing when amlReviewAutoManaged is false (manual override in effect)', async () => {
    merchantService.findByMerchantId.mockResolvedValue(createMerchant({ amlReviewAutoManaged: false }));
    await service.evaluate('merchant_high_risk', 'stolen_card', 'STRIPE');
    expect(paymentRepository.countHardDeclinesSince).not.toHaveBeenCalled();
  });

  it('does not flag below the threshold', async () => {
    merchantService.findByMerchantId.mockResolvedValue(createMerchant());
    paymentRepository.countHardDeclinesSince.mockResolvedValue(4);
    process.env.AML_REVIEW_HARD_DECLINE_THRESHOLD = '5';
    service = new AmlReviewMonitoringService(paymentRepository, merchantService, notificationDispatcher);

    await service.evaluate('merchant_high_risk', 'stolen_card', 'STRIPE');
    expect(merchantService.applyAutoAmlReviewFlag).not.toHaveBeenCalled();
    expect(notificationDispatcher.notify).not.toHaveBeenCalled();
    delete process.env.AML_REVIEW_HARD_DECLINE_THRESHOLD;
  });

  it('flags and notifies once the threshold is crossed', async () => {
    merchantService.findByMerchantId.mockResolvedValue(createMerchant());
    paymentRepository.countHardDeclinesSince.mockResolvedValue(5);
    process.env.AML_REVIEW_HARD_DECLINE_THRESHOLD = '5';
    process.env.AML_REVIEW_WINDOW_DAYS = '30';
    service = new AmlReviewMonitoringService(paymentRepository, merchantService, notificationDispatcher);

    await service.evaluate('merchant_high_risk', 'stolen_card', 'STRIPE');

    expect(merchantService.applyAutoAmlReviewFlag).toHaveBeenCalledWith(
      'merchant_high_risk',
      true,
      expect.stringContaining('5 hard-declines'),
    );
    expect(notificationDispatcher.notify).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'aml_review.flagged', merchantId: 'merchant_high_risk', hardDeclineCount: 5 }),
    );
    delete process.env.AML_REVIEW_HARD_DECLINE_THRESHOLD;
    delete process.env.AML_REVIEW_WINDOW_DAYS;
  });

  it('re-touches an already-flagged merchant without re-notifying', async () => {
    merchantService.findByMerchantId.mockResolvedValue(
      createMerchant({ amlReviewFlagged: true, amlReviewFlagReason: 'already flagged reason' }),
    );

    await service.evaluate('merchant_high_risk', 'stolen_card', 'STRIPE');

    expect(merchantService.applyAutoAmlReviewFlag).toHaveBeenCalledWith(
      'merchant_high_risk',
      true,
      'already flagged reason',
    );
    expect(paymentRepository.countHardDeclinesSince).not.toHaveBeenCalled();
    expect(notificationDispatcher.notify).not.toHaveBeenCalled();
  });

  it('a notification failure does not prevent the flag from having been set', async () => {
    merchantService.findByMerchantId.mockResolvedValue(createMerchant());
    paymentRepository.countHardDeclinesSince.mockResolvedValue(5);
    notificationDispatcher.notify.mockRejectedValue(new Error('delivery failed'));
    process.env.AML_REVIEW_HARD_DECLINE_THRESHOLD = '5';
    service = new AmlReviewMonitoringService(paymentRepository, merchantService, notificationDispatcher);

    await expect(service.evaluate('merchant_high_risk', 'stolen_card', 'STRIPE')).resolves.not.toThrow();
    expect(merchantService.applyAutoAmlReviewFlag).toHaveBeenCalled();
    delete process.env.AML_REVIEW_HARD_DECLINE_THRESHOLD;
  });
});
