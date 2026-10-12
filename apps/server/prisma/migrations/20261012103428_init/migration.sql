-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "ScenarioStatus" AS ENUM ('draft', 'published', 'hidden_by_author', 'hidden_by_report', 'hidden_by_admin');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "display_name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "agreed_age_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenarios" (
    "id" UUID NOT NULL,
    "slug" TEXT,
    "author_id" UUID,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "intro_text" TEXT NOT NULL,
    "ending_text" TEXT NOT NULL,
    "status" "ScenarioStatus" NOT NULL DEFAULT 'draft',
    "check_result" JSONB,
    "content_version" INTEGER NOT NULL DEFAULT 1,
    "published_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "characters" (
    "id" UUID NOT NULL,
    "scenario_id" UUID NOT NULL,
    "slot" SMALLINT NOT NULL,
    "name" TEXT NOT NULL,
    "public_profile" TEXT NOT NULL,
    "situation_text" TEXT NOT NULL,
    "is_culprit" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "characters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cards" (
    "id" UUID NOT NULL,
    "character_id" UUID NOT NULL,
    "slot" SMALLINT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,

    CONSTRAINT "cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "played_scenarios" (
    "user_id" UUID NOT NULL,
    "scenario_id" UUID NOT NULL,
    "first_played_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "played_scenarios_pkey" PRIMARY KEY ("user_id","scenario_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "scenarios_slug_key" ON "scenarios"("slug");

-- CreateIndex
CREATE INDEX "scenarios_status_published_at_idx" ON "scenarios"("status", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "characters_scenario_id_slot_key" ON "characters"("scenario_id", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "cards_character_id_slot_key" ON "cards"("character_id", "slot");

-- AddForeignKey
ALTER TABLE "scenarios" ADD CONSTRAINT "scenarios_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "characters" ADD CONSTRAINT "characters_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards" ADD CONSTRAINT "cards_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "played_scenarios" ADD CONSTRAINT "played_scenarios_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "played_scenarios" ADD CONSTRAINT "played_scenarios_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 犯人は1シナリオにつき1人だけ（設計書 §5.3）
CREATE UNIQUE INDEX "characters_one_culprit_per_scenario" ON "characters"("scenario_id") WHERE "is_culprit";
