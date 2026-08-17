CREATE TABLE `side_effect_executions` (
	`id` varchar(36) NOT NULL,
	`eventId` varchar(36) NOT NULL,
	`operationKey` varchar(320) NOT NULL,
	`completedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `side_effect_executions_id` PRIMARY KEY(`id`),
	CONSTRAINT `side_effect_executions_operation_uq` UNIQUE(`operationKey`)
);
--> statement-breakpoint
ALTER TABLE `events` ADD `operationKey` varchar(320);--> statement-breakpoint
UPDATE `events` SET `operationKey` = CONCAT('legacy:', `id`) WHERE `operationKey` IS NULL OR `operationKey` = '';--> statement-breakpoint
ALTER TABLE `events` MODIFY `operationKey` varchar(320) NOT NULL;--> statement-breakpoint
ALTER TABLE `side_effect_executions` ADD CONSTRAINT `side_effect_executions_eventId_events_id_fk` FOREIGN KEY (`eventId`) REFERENCES `events`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO `side_effect_executions` (`id`, `eventId`, `operationKey`, `completedAt`) SELECT UUID(), `id`, `operationKey`, `updatedAt` FROM `events` WHERE `status` = 'completed';--> statement-breakpoint
CREATE INDEX `side_effect_executions_event_idx` ON `side_effect_executions` (`eventId`);
