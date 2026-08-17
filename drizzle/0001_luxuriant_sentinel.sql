CREATE TABLE `approvals` (
	`id` varchar(36) NOT NULL,
	`eventId` varchar(36) NOT NULL,
	`decision` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`operatorName` varchar(128),
	`comment` text,
	`decidedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `approvals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_records` (
	`id` varchar(36) NOT NULL,
	`eventId` varchar(36) NOT NULL,
	`action` varchar(96) NOT NULL,
	`message` text NOT NULL,
	`metadata` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_records_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `event_attempts` (
	`id` varchar(36) NOT NULL,
	`eventId` varchar(36) NOT NULL,
	`attemptNumber` int NOT NULL,
	`result` enum('success','error','paused') NOT NULL,
	`detail` text,
	`scheduledFor` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `event_attempts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` varchar(36) NOT NULL,
	`source` enum('form_submission','payment','telegram_message','downstream_api_failure') NOT NULL,
	`idempotencyKey` varchar(255) NOT NULL,
	`correlationId` varchar(64) NOT NULL,
	`status` enum('received','processing','completed','failed','pending_approval') NOT NULL DEFAULT 'received',
	`payload` json NOT NULL,
	`maskedPayload` json NOT NULL,
	`retryCount` int NOT NULL DEFAULT 0,
	`maxRetries` int NOT NULL DEFAULT 3,
	`nextRetryAt` timestamp,
	`isDeadLetter` boolean NOT NULL DEFAULT false,
	`replayOfEventId` varchar(36),
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `events_id` PRIMARY KEY(`id`),
	CONSTRAINT `events_source_idempotency_uq` UNIQUE(`source`,`idempotencyKey`)
);
--> statement-breakpoint
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_eventId_events_id_fk` FOREIGN KEY (`eventId`) REFERENCES `events`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_records` ADD CONSTRAINT `audit_records_eventId_events_id_fk` FOREIGN KEY (`eventId`) REFERENCES `events`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `event_attempts` ADD CONSTRAINT `event_attempts_eventId_events_id_fk` FOREIGN KEY (`eventId`) REFERENCES `events`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `approvals_event_idx` ON `approvals` (`eventId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `audit_records_event_idx` ON `audit_records` (`eventId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `event_attempts_event_idx` ON `event_attempts` (`eventId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `events_status_received_idx` ON `events` (`status`,`receivedAt`);--> statement-breakpoint
CREATE INDEX `events_correlation_idx` ON `events` (`correlationId`);