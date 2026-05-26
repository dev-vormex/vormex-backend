CREATE TABLE "campus_events" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "campus" TEXT NOT NULL,
  "venue" TEXT,
  "isOnline" BOOLEAN NOT NULL DEFAULT false,
  "meetingLink" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "maxAttendees" INTEGER,
  "attendeesCount" INTEGER NOT NULL DEFAULT 0,
  "organizerId" TEXT NOT NULL,
  "circleId" TEXT,
  "coverImageUrl" TEXT,
  "tags" TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "campus_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "event_attendees" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'going',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "event_attendees_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "campus_events_campus_idx" ON "campus_events"("campus");
CREATE INDEX "campus_events_campus_startsAt_idx" ON "campus_events"("campus", "startsAt");
CREATE INDEX "campus_events_organizerId_idx" ON "campus_events"("organizerId");
CREATE INDEX "campus_events_circleId_idx" ON "campus_events"("circleId");
CREATE INDEX "campus_events_startsAt_idx" ON "campus_events"("startsAt");
CREATE INDEX "event_attendees_eventId_idx" ON "event_attendees"("eventId");
CREATE INDEX "event_attendees_userId_idx" ON "event_attendees"("userId");
CREATE UNIQUE INDEX "event_attendees_eventId_userId_key" ON "event_attendees"("eventId", "userId");

ALTER TABLE "campus_events"
  ADD CONSTRAINT "campus_events_circleId_fkey"
  FOREIGN KEY ("circleId") REFERENCES "circles"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "event_attendees"
  ADD CONSTRAINT "event_attendees_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "campus_events"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "event_attendees"
  ADD CONSTRAINT "event_attendees_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
