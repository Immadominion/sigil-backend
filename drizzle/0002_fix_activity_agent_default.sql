ALTER TABLE "activity_log" ALTER COLUMN "agent_id" DROP DEFAULT;
DROP SEQUENCE IF EXISTS "activity_log_agent_id_seq";
