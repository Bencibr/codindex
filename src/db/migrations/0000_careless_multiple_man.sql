CREATE TABLE `calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`caller_func_id` integer,
	`callee_func_id` integer,
	`caller_file_id` integer NOT NULL,
	`callee_file_id` integer,
	`call_line` integer,
	`call_type` text,
	`callee_name` text,
	`is_external` integer DEFAULT false,
	`bridge_target` text,
	`bridge_framework` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`caller_func_id`) REFERENCES `functions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`callee_func_id`) REFERENCES `functions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`caller_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`callee_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_call_edge` ON `calls` (`project_id`,`caller_func_id`,`callee_func_id`,`call_line`);--> statement-breakpoint
CREATE INDEX `idx_call_caller` ON `calls` (`caller_func_id`);--> statement-breakpoint
CREATE INDEX `idx_call_callee` ON `calls` (`callee_func_id`);--> statement-breakpoint
CREATE TABLE `control_flow_edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`func_id` integer NOT NULL,
	`source_node_id` text NOT NULL,
	`target_node_id` text NOT NULL,
	`edge_label` text,
	`edge_type` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`func_id`) REFERENCES `functions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_cfg_edge_project` ON `control_flow_edges` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_cfg_edge_func` ON `control_flow_edges` (`func_id`);--> statement-breakpoint
CREATE TABLE `control_flow_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`func_id` integer NOT NULL,
	`node_id` text NOT NULL,
	`node_type` text NOT NULL,
	`label` text,
	`line_start` integer,
	`line_end` integer,
	`callee_func_id` integer,
	`condition_expr` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`func_id`) REFERENCES `functions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_cfg_node_project` ON `control_flow_nodes` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_cfg_node_func` ON `control_flow_nodes` (`func_id`);--> statement-breakpoint
CREATE TABLE `feature_code` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feature_id` text NOT NULL,
	`func_id` integer NOT NULL,
	`file_id` integer NOT NULL,
	`mapping_type` text,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`func_id`) REFERENCES `functions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `features` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`prd_section` text,
	`priority` text DEFAULT 'medium',
	`status` text DEFAULT 'unknown',
	`completion` real DEFAULT 0,
	`created_at` integer DEFAULT (unixepoch()),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`path` text NOT NULL,
	`module` text,
	`language` text NOT NULL,
	`lines` integer DEFAULT 0,
	`code_lines` integer DEFAULT 0,
	`comment_lines` integer DEFAULT 0,
	`complexity` real,
	`last_modified` integer,
	`authors` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_file_project_path` ON `files` (`project_id`,`path`);--> statement-breakpoint
CREATE TABLE `functions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`file_id` integer NOT NULL,
	`name` text NOT NULL,
	`full_name` text,
	`kind` text,
	`signature` text,
	`body` text,
	`summary` text,
	`line_start` integer,
	`line_end` integer,
	`complexity` real,
	`params_count` integer DEFAULT 0,
	`lines_count` integer DEFAULT 0,
	`is_exported` integer DEFAULT false,
	`is_test` integer DEFAULT false,
	`doc_comment` text,
	`tags` text,
	`feature_id` text,
	`reuse_score` real,
	`coupling_count` integer DEFAULT 0,
	`dependency_count` integer DEFAULT 0,
	`param_similarity` real,
	`generic_level` integer DEFAULT 0,
	`params_json` text,
	`return_type` text,
	`is_placeholder` integer DEFAULT false,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_func_project_file_name` ON `functions` (`project_id`,`file_id`,`name`,`line_start`);--> statement-breakpoint
CREATE INDEX `idx_func_project` ON `functions` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_func_file` ON `functions` (`file_id`);--> statement-breakpoint
CREATE TABLE `module_deps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`module_id` integer NOT NULL,
	`dep_module_id` integer NOT NULL,
	`dep_type` text,
	`weight` integer DEFAULT 1,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dep_module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_module_dep` ON `module_deps` (`module_id`,`dep_module_id`,`dep_type`);--> statement-breakpoint
CREATE TABLE `modules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`parent_id` integer,
	`depth` integer DEFAULT 0,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_module_project_path` ON `modules` (`project_id`,`path`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`language` text,
	`status` text DEFAULT 'pending',
	`last_scanned` integer,
	`scan_progress` integer,
	`prd_path` text,
	`created_at` integer DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_path` ON `projects` (`path`);--> statement-breakpoint
CREATE TABLE `raise_edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`func_id` integer NOT NULL,
	`file_id` integer NOT NULL,
	`error_type` text NOT NULL,
	`line` integer,
	`kind` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`func_id`) REFERENCES `functions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_raise_unique` ON `raise_edges` (`project_id`,`func_id`,`error_type`,`line`);--> statement-breakpoint
CREATE INDEX `idx_raise_project` ON `raise_edges` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_raise_error` ON `raise_edges` (`project_id`,`error_type`);--> statement-breakpoint
CREATE INDEX `idx_raise_func` ON `raise_edges` (`func_id`);--> statement-breakpoint
CREATE TABLE `test_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`test_func_id` integer NOT NULL,
	`target_func_id` integer,
	`confidence` real DEFAULT 0.8,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`test_func_id`) REFERENCES `functions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_func_id`) REFERENCES `functions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_test_mapping` ON `test_mappings` (`project_id`,`test_func_id`,`target_func_id`);--> statement-breakpoint
CREATE TABLE `type_fields` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type_id` integer NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`field_type` text NOT NULL,
	`visibility` text,
	`is_optional` integer DEFAULT false,
	`default_value` text,
	`line_start` integer,
	FOREIGN KEY (`type_id`) REFERENCES `types`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_type_field` ON `type_fields` (`type_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_type_field_project` ON `type_fields` (`project_id`);--> statement-breakpoint
CREATE TABLE `type_usage_edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`func_id` integer NOT NULL,
	`type_id` integer NOT NULL,
	`usage_type` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`func_id`) REFERENCES `functions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`type_id`) REFERENCES `types`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_type_usage` ON `type_usage_edges` (`project_id`,`func_id`,`type_id`,`usage_type`);--> statement-breakpoint
CREATE INDEX `idx_type_usage_type` ON `type_usage_edges` (`type_id`);--> statement-breakpoint
CREATE TABLE `types` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`file_id` integer NOT NULL,
	`name` text NOT NULL,
	`kind` text,
	`parent_type` text,
	`implements` text,
	`generic_params` text,
	`line_start` integer,
	`line_end` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_type_project_file_name` ON `types` (`project_id`,`file_id`,`name`);