-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('playing', 'finished', 'aborted');

-- CreateEnum
CREATE TYPE "ParticipantKind" AS ENUM ('human', 'npc');

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('win', 'lose', 'left', 'npc');

-- CreateTable
CREATE TABLE "games" (
    "id" UUID NOT NULL,
    "scenario_id" UUID NOT NULL,
    "scenario_version" INTEGER NOT NULL,
    "status" "GameStatus" NOT NULL DEFAULT 'playing',
    "result" JSONB,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participations" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "seat" SMALLINT NOT NULL,
    "character_id" UUID NOT NULL,
    "user_id" UUID,
    "initial_kind" "ParticipantKind" NOT NULL,
    "switched_to_npc_at" TIMESTAMPTZ,
    "outcome" "Outcome",

    CONSTRAINT "participations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "participation_id" UUID NOT NULL,
    "set_no" SMALLINT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revealed_cards" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "participation_id" UUID NOT NULL,
    "card_id" UUID NOT NULL,
    "set_no" SMALLINT NOT NULL,
    "auto_selected" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "revealed_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "votes" (
    "game_id" UUID NOT NULL,
    "voter_participation_id" UUID NOT NULL,
    "target_participation_id" UUID,

    CONSTRAINT "votes_pkey" PRIMARY KEY ("game_id","voter_participation_id")
);

-- CreateIndex
CREATE INDEX "games_status_idx" ON "games"("status");

-- CreateIndex
CREATE INDEX "participations_user_id_idx" ON "participations"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "participations_game_id_seat_key" ON "participations"("game_id", "seat");

-- CreateIndex
CREATE INDEX "chat_messages_game_id_idx" ON "chat_messages"("game_id");

-- CreateIndex
CREATE UNIQUE INDEX "revealed_cards_game_id_card_id_key" ON "revealed_cards"("game_id", "card_id");

-- AddForeignKey
ALTER TABLE "games" ADD CONSTRAINT "games_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participations" ADD CONSTRAINT "participations_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participations" ADD CONSTRAINT "participations_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "characters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "participations" ADD CONSTRAINT "participations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_participation_id_fkey" FOREIGN KEY ("participation_id") REFERENCES "participations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revealed_cards" ADD CONSTRAINT "revealed_cards_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revealed_cards" ADD CONSTRAINT "revealed_cards_participation_id_fkey" FOREIGN KEY ("participation_id") REFERENCES "participations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revealed_cards" ADD CONSTRAINT "revealed_cards_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votes" ADD CONSTRAINT "votes_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votes" ADD CONSTRAINT "votes_voter_participation_id_fkey" FOREIGN KEY ("voter_participation_id") REFERENCES "participations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "votes" ADD CONSTRAINT "votes_target_participation_id_fkey" FOREIGN KEY ("target_participation_id") REFERENCES "participations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
