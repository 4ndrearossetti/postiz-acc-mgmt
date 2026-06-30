-- Throwaway Postiz-shaped schema for tests (NOT the live DB).
-- Faithful to Postiz conventions: PascalCase tables, String(text) ids, the
-- Provider/Role enums, no onDelete cascades (all FKs RESTRICT), unique
-- (email,providerName) and (userId,organizationId). Includes the load-bearing
-- awkward cases: a self-reference (Post.parentPostId) and a cycle
-- (Orders <-> MessagesGroup), plus grandchildren scoped only through a parent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

DO $$ BEGIN
  CREATE TYPE "Provider" AS ENUM ('LOCAL','GITHUB','GOOGLE','FARCASTER','WALLET','GENERIC');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "Role" AS ENUM ('SUPERADMIN','ADMIN','USER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE "User" (
  id            text PRIMARY KEY,
  email         text NOT NULL,
  password      text,
  "providerName" "Provider" NOT NULL DEFAULT 'LOCAL',
  name          text,
  timezone      integer NOT NULL,
  activated     boolean NOT NULL DEFAULT true,
  "createdAt"   timestamptz NOT NULL,
  "updatedAt"   timestamptz NOT NULL,
  CONSTRAINT "User_email_providerName_key" UNIQUE (email, "providerName")
);

CREATE TABLE "Organization" (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  "apiKey"     text,
  "allowTrial" boolean NOT NULL DEFAULT true,
  "isTrailing" boolean NOT NULL DEFAULT true,
  "createdAt"  timestamptz NOT NULL,
  "updatedAt"  timestamptz NOT NULL
);

CREATE TABLE "UserOrganization" (
  id               text PRIMARY KEY,
  "userId"         text NOT NULL REFERENCES "User"(id),
  "organizationId" text NOT NULL REFERENCES "Organization"(id),
  role             "Role" NOT NULL DEFAULT 'USER',
  disabled         boolean NOT NULL DEFAULT false,
  "createdAt"      timestamptz NOT NULL,
  "updatedAt"      timestamptz NOT NULL,
  CONSTRAINT "UserOrganization_userId_organizationId_key" UNIQUE ("userId","organizationId")
);

CREATE TABLE "Integration" (
  id               text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "Organization"(id),
  name             text
);

CREATE TABLE "IntegrationsWebhooks" (
  id              text PRIMARY KEY,
  "integrationId" text NOT NULL REFERENCES "Integration"(id)
);

CREATE TABLE "Post" (
  id                          text PRIMARY KEY,
  "organizationId"            text NOT NULL REFERENCES "Organization"(id),
  "parentPostId"              text REFERENCES "Post"(id),          -- self-reference
  "submittedForOrganizationId" text REFERENCES "Organization"(id),
  content                     text
);

CREATE TABLE "Tags" (
  id     text PRIMARY KEY,
  "orgId" text NOT NULL REFERENCES "Organization"(id),
  name    text
);

CREATE TABLE "TagsPosts" (
  id       text PRIMARY KEY,
  "postId" text NOT NULL REFERENCES "Post"(id),
  "tagId"  text NOT NULL REFERENCES "Tags"(id)
);

CREATE TABLE "Comments" (
  id               text PRIMARY KEY,
  "organizationId" text REFERENCES "Organization"(id),
  "userId"         text REFERENCES "User"(id),
  "postId"         text REFERENCES "Post"(id)
);

CREATE TABLE "Customer" (
  id      text PRIMARY KEY,
  "orgId" text NOT NULL REFERENCES "Organization"(id)
);

CREATE TABLE "Media" (
  id               text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "Organization"(id)
);

-- Marketplace cycle: Orders <-> MessagesGroup (both FK columns nullable).
CREATE TABLE "Orders" (
  id               text PRIMARY KEY,
  "buyerId"        text REFERENCES "User"(id),
  "sellerId"       text REFERENCES "User"(id),
  "messageGroupId" text   -- FK added after MessagesGroup exists
);

CREATE TABLE "MessagesGroup" (
  id                    text PRIMARY KEY,
  "buyerOrganizationId" text REFERENCES "Organization"(id),
  "buyerId"             text REFERENCES "User"(id),
  "sellerId"            text REFERENCES "User"(id),
  "orderId"            text REFERENCES "Orders"(id)
);

ALTER TABLE "Orders"
  ADD CONSTRAINT "Orders_messageGroupId_fkey"
  FOREIGN KEY ("messageGroupId") REFERENCES "MessagesGroup"(id);

CREATE TABLE "Messages" (
  id        text PRIMARY KEY,
  "groupId" text NOT NULL REFERENCES "MessagesGroup"(id)
);
