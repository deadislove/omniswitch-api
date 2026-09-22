import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWebhookDeliveries1788451800000 implements MigrationInterface {
  name = 'CreateWebhookDeliveries1788451800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "webhook_deliveries" (
        "id" uuid NOT NULL,
        "merchant_id" character varying NOT NULL,
        "event_type" character varying NOT NULL,
        "target_url" character varying NOT NULL,
        "payload" jsonb NOT NULL,
        "success" boolean NOT NULL,
        "status_code" integer,
        "error_message" character varying,
        "latency_ms" integer NOT NULL,
        "replay_of_delivery_id" uuid,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_webhook_deliveries" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_deliveries_merchant_id_created_at" ON "webhook_deliveries" ("merchant_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_webhook_deliveries_replay_of_delivery_id" ON "webhook_deliveries" ("replay_of_delivery_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_webhook_deliveries_replay_of_delivery_id"`);
    await queryRunner.query(`DROP INDEX "IDX_webhook_deliveries_merchant_id_created_at"`);
    await queryRunner.query(`DROP TABLE "webhook_deliveries"`);
  }
}
