-- CreateEnum
CREATE TYPE "CardKind" AS ENUM ('testimony', 'item');

-- AlterTable
-- 既存のカードは種類が無いため、いったん testimony で埋めてから既定値を外す。
-- 運営シナリオは db:reseed で入れ直す。
ALTER TABLE "cards" ADD COLUMN     "is_fabricated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" "CardKind" NOT NULL DEFAULT 'testimony';
ALTER TABLE "cards" ALTER COLUMN "kind" DROP DEFAULT;
