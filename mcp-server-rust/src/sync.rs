use crate::config::{
    load_workspace_link, update_workspace_sync_metadata, PanicPolicy, ProjectScope,
};
use crate::models::{AgentInstructionSet, InstructionHashResponse, SyncResult};
use crate::resources::ResourceService;
use anyhow::Result;
use chrono::Utc;
use futures::FutureExt;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::fs;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

const SYNC_START: &str = "<!-- BEGIN:pinksundew-sync -->";
const SYNC_END: &str = "<!-- END:pinksundew-sync -->";
const CURSOR_SYNC_TARGET_TOGGLE: &str = "sync_target_cursor";
const WINDSURF_SYNC_TARGET_TOGGLE: &str = "sync_target_windsurf";
const VSCODE_SYNC_TARGET_TOGGLE: &str = "sync_target_vscode";
const CODEX_SYNC_TARGET_TOGGLE: &str = "sync_target_codex";
const CLAUDE_SYNC_TARGET_TOGGLE: &str = "sync_target_claude";
const ANTIGRAVITY_SYNC_TARGET_TOGGLE: &str = "sync_target_antigravity";
const CURSOR_RULES_DIR: &str = ".cursor/rules";
const CURSOR_RULES_DISPLAY_PATH: &str = ".cursor/rules/*.mdc";
const CURSOR_GLOBAL_RULE_FILE: &str = ".cursor/rules/pinksundew-global.mdc";
const CURSOR_MANAGED_RULE_PREFIX: &str = "pinksundew-";
const LEGACY_CURSOR_RULE_FILE: &str = ".cursorrules";
const WINDSURF_RULES_DIR: &str = ".windsurf/rules";
const WINDSURF_RULES_DISPLAY_PATH: &str = ".windsurf/rules/*.md";
const WINDSURF_GLOBAL_RULE_FILE: &str = ".windsurf/rules/pinksundew-global.md";
const WINDSURF_MANAGED_RULE_PREFIX: &str = "pinksundew-";
const LEGACY_WINDSURF_RULE_FILE: &str = ".windsurfrules";
const COPILOT_ROOT_FILE: &str = ".github/copilot-instructions.md";
const COPILOT_INSTRUCTIONS_DIR: &str = ".github/instructions";
const COPILOT_INSTRUCTIONS_DISPLAY_PATH: &str = ".github/instructions/*.instructions.md";
const COPILOT_MANAGED_RULE_PREFIX: &str = "pinksundew-";
const CODEX_ROOT_FILE: &str = "AGENTS.md";
const CLAUDE_ROOT_FILE: &str = "CLAUDE.md";
const ANTIGRAVITY_ROOT_FILE: &str = "antigravity.md";
const CONTEXT_DOCS_DIR: &str = ".pinksundew/docs/";
const CONTEXT_DOCS_NOTE: &str =
    "Project context documents live in .pinksundew/docs/. Read them before making architectural changes.";
const CONDITIONAL_DOCS_HEADING: &str = "Conditional Pink Sundew Instruction Docs";

#[derive(Debug, Clone, PartialEq, Eq)]
enum InstructionRoutingMode {
    Always,
    MatchFiles,
    AgentDecides,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InstructionRoutingMetadata {
    title: String,
    mode: InstructionRoutingMode,
    description: String,
    globs: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedInstructionDocument {
    body: String,
    routing: InstructionRoutingMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CustomInstructionDocument {
    relative_path: String,
    body: String,
    routing: InstructionRoutingMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GeneratedTextFile {
    relative_path: String,
    content: String,
}

#[expect(
    dead_code,
    reason = "reference-only manifests remain available for follow-up env integrations"
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManifestStyle {
    ReferenceOnly,
    InlineAlwaysWithConditionalManifest,
}

#[derive(Clone)]
pub struct SyncService {
    resources: ResourceService,
    scope: ProjectScope,
}

impl SyncService {
    pub fn new(resources: ResourceService, scope: ProjectScope) -> Self {
        Self { resources, scope }
    }

    pub async fn sync_global_instructions(
        &self,
        workspace_root: Option<PathBuf>,
        verbose: bool,
    ) -> SyncResult {
        let workspace_root = workspace_root
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

        let project_id = self.scope.project_id().to_string();
        let (
            claude_target_enabled,
            windsurf_target_enabled,
            vscode_target_enabled,
            codex_target_enabled,
            antigravity_target_enabled,
            cursor_target_enabled,
            output_files,
        ) = match self.resources.get_project_agent_controls(&project_id).await {
            Ok(controls) => {
                let claude_target_enabled = controls
                    .tool_toggles
                    .get(CLAUDE_SYNC_TARGET_TOGGLE)
                    .copied()
                    .unwrap_or(false);
                let windsurf_target_enabled = controls
                    .tool_toggles
                    .get(WINDSURF_SYNC_TARGET_TOGGLE)
                    .copied()
                    .unwrap_or(false);
                let vscode_target_enabled = controls
                    .tool_toggles
                    .get(VSCODE_SYNC_TARGET_TOGGLE)
                    .copied()
                    .unwrap_or(false);
                let codex_target_enabled = controls
                    .tool_toggles
                    .get(CODEX_SYNC_TARGET_TOGGLE)
                    .copied()
                    .unwrap_or(false);
                let antigravity_target_enabled = controls
                    .tool_toggles
                    .get(ANTIGRAVITY_SYNC_TARGET_TOGGLE)
                    .copied()
                    .unwrap_or(false);
                let cursor_target_enabled = controls
                    .tool_toggles
                    .get(CURSOR_SYNC_TARGET_TOGGLE)
                    .copied()
                    .unwrap_or(false);

                let mut output_files = Vec::new();
                if claude_target_enabled {
                    output_files.push(CLAUDE_ROOT_FILE.to_string());
                }
                if windsurf_target_enabled {
                    output_files.push(WINDSURF_RULES_DISPLAY_PATH.to_string());
                }
                if vscode_target_enabled {
                    output_files.push(COPILOT_ROOT_FILE.to_string());
                    output_files.push(COPILOT_INSTRUCTIONS_DISPLAY_PATH.to_string());
                }
                if codex_target_enabled {
                    output_files.push(CODEX_ROOT_FILE.to_string());
                }
                if antigravity_target_enabled {
                    output_files.push(ANTIGRAVITY_ROOT_FILE.to_string());
                }
                if cursor_target_enabled {
                    output_files.push(CURSOR_RULES_DISPLAY_PATH.to_string());
                }

                (
                    claude_target_enabled,
                    windsurf_target_enabled,
                    vscode_target_enabled,
                    codex_target_enabled,
                    antigravity_target_enabled,
                    cursor_target_enabled,
                    output_files,
                )
            }
            Err(err) => {
                if verbose {
                    warn!(target: "pinksundew::sync", "[sync] Failed to load board sync targets: {err}");
                }
                (false, false, false, false, false, false, Vec::new())
            }
        };
        let output_files = get_output_file_paths(&output_files);

        if verbose {
            if !output_files.is_empty() {
                info!(target: "pinksundew::sync", "[sync] Board-configured sync targets: {}", output_files.join(", "));
            } else {
                info!(target: "pinksundew::sync", "[sync] No sync targets enabled for linked project.");
            }
        }

        let fetched = fetch_active_instructions(&self.resources, &project_id).await;
        let (project_name, instructions) = match fetched {
            Ok(value) => value,
            Err(err) => {
                if verbose {
                    error!(target: "pinksundew::sync", "[sync] Failed to fetch instructions: {err}");
                }
                return SyncResult {
                    success: false,
                    project_id: Some(project_id),
                    project_name: None,
                    file_written: None,
                    files_written: Vec::new(),
                    instruction_count: 0,
                    error: Some(err.to_string()),
                };
            }
        };

        let global_rule_content_blocks = collect_global_rule_content_blocks(&instructions);
        let custom_documents = collect_custom_instruction_documents(&instructions);

        let mut files_written = Vec::new();
        let mut write_errors = Vec::new();

        if codex_target_enabled {
            let sync_block = build_single_file_sync_block(
                &global_rule_content_blocks,
                &custom_documents,
                &project_name,
                ManifestStyle::InlineAlwaysWithConditionalManifest,
            );
            let full_path = workspace_root.join(CODEX_ROOT_FILE);
            match write_instruction_file(&full_path, &sync_block).await {
                Ok(_) => {
                    if verbose {
                        info!(target: "pinksundew::sync", "[sync] Wrote {}", CODEX_ROOT_FILE);
                    }
                    files_written.push(CODEX_ROOT_FILE.to_string());
                }
                Err(err) => {
                    let message = format!("Failed to write {}: {}", CODEX_ROOT_FILE, err);
                    if verbose {
                        error!(target: "pinksundew::sync", "[sync] {}", message);
                    }
                    write_errors.push(message);
                }
            }
        }

        if claude_target_enabled {
            let sync_block = build_single_file_sync_block(
                &global_rule_content_blocks,
                &custom_documents,
                &project_name,
                ManifestStyle::InlineAlwaysWithConditionalManifest,
            );
            let full_path = workspace_root.join(CLAUDE_ROOT_FILE);
            match write_instruction_file(&full_path, &sync_block).await {
                Ok(_) => {
                    if verbose {
                        info!(target: "pinksundew::sync", "[sync] Wrote {}", CLAUDE_ROOT_FILE);
                    }
                    files_written.push(CLAUDE_ROOT_FILE.to_string());
                }
                Err(err) => {
                    let message = format!("Failed to write {}: {}", CLAUDE_ROOT_FILE, err);
                    if verbose {
                        error!(target: "pinksundew::sync", "[sync] {}", message);
                    }
                    write_errors.push(message);
                }
            }
        }

        if antigravity_target_enabled {
            let sync_block = build_single_file_sync_block(
                &global_rule_content_blocks,
                &custom_documents,
                &project_name,
                ManifestStyle::InlineAlwaysWithConditionalManifest,
            );
            let full_path = workspace_root.join(ANTIGRAVITY_ROOT_FILE);
            match write_instruction_file(&full_path, &sync_block).await {
                Ok(_) => {
                    if verbose {
                        info!(target: "pinksundew::sync", "[sync] Wrote {}", ANTIGRAVITY_ROOT_FILE);
                    }
                    files_written.push(ANTIGRAVITY_ROOT_FILE.to_string());
                }
                Err(err) => {
                    let message = format!("Failed to write {}: {}", ANTIGRAVITY_ROOT_FILE, err);
                    if verbose {
                        error!(target: "pinksundew::sync", "[sync] {}", message);
                    }
                    write_errors.push(message);
                }
            }
        }

        if cursor_target_enabled {
            match sync_cursor_rule_files(
                &workspace_root,
                &global_rule_content_blocks,
                &custom_documents,
                &project_name,
                verbose,
            )
            .await
            {
                Ok(cursor_files) => files_written.extend(cursor_files),
                Err(err) => {
                    let message = format!("Failed to write Cursor project rules: {}", err);
                    if verbose {
                        error!(target: "pinksundew::sync", "[sync] {}", message);
                    }
                    write_errors.push(message);
                }
            }
        }

        if windsurf_target_enabled {
            match sync_windsurf_rule_files(
                &workspace_root,
                &global_rule_content_blocks,
                &custom_documents,
                &project_name,
                verbose,
            )
            .await
            {
                Ok(files) => files_written.extend(files),
                Err(err) => {
                    let message = format!("Failed to write Windsurf rules: {}", err);
                    if verbose {
                        error!(target: "pinksundew::sync", "[sync] {}", message);
                    }
                    write_errors.push(message);
                }
            }
        }

        if vscode_target_enabled {
            match sync_copilot_instruction_files(
                &workspace_root,
                &global_rule_content_blocks,
                &custom_documents,
                &project_name,
                verbose,
            )
            .await
            {
                Ok(files) => files_written.extend(files),
                Err(err) => {
                    let message = format!("Failed to write Copilot instruction files: {}", err);
                    if verbose {
                        error!(target: "pinksundew::sync", "[sync] {}", message);
                    }
                    write_errors.push(message);
                }
            }
        }

        for (relative_path, content) in collect_context_documents(&custom_documents) {
            let full_path = workspace_root.join(relative_path.as_str());
            match write_context_document(&full_path, &content).await {
                Ok(_) => {
                    if verbose {
                        info!(target: "pinksundew::sync", "[sync] Wrote {}", relative_path);
                    }
                    files_written.push(relative_path);
                }
                Err(err) => {
                    let message = format!("Failed to write {}: {}", relative_path, err);
                    if verbose {
                        error!(target: "pinksundew::sync", "[sync] {}", message);
                    }
                    write_errors.push(message);
                }
            }
        }

        if !write_errors.is_empty() {
            return SyncResult {
                success: false,
                project_id: Some(project_id),
                project_name: Some(project_name),
                file_written: if files_written.is_empty() {
                    None
                } else {
                    Some(files_written.join(", "))
                },
                files_written,
                instruction_count: 0,
                error: Some(write_errors.join(" | ")),
            };
        }

        let instruction_count = instructions
            .iter()
            .map(|set| {
                set.files
                    .iter()
                    .filter(|file| {
                        file.content
                            .as_deref()
                            .map(str::trim)
                            .map(|content| !content.is_empty())
                            .unwrap_or(false)
                    })
                    .count()
            })
            .sum();

        let _ = update_workspace_sync_metadata(&workspace_root, None);

        SyncResult {
            success: true,
            project_id: Some(project_id),
            project_name: Some(project_name),
            file_written: Some(files_written.join(", ")),
            files_written,
            instruction_count,
            error: None,
        }
    }

    pub async fn read_local_hash(&self, workspace_root: Option<PathBuf>) -> Option<String> {
        let root = workspace_root
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        load_workspace_link(root.as_path())
            .ok()
            .and_then(|link| link.last_instruction_hash)
    }

    pub async fn save_local_hash(&self, hash: &str, workspace_root: Option<PathBuf>) {
        let root = workspace_root
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let _ = update_workspace_sync_metadata(root.as_path(), Some(hash));
    }

    pub async fn fetch_cloud_hash(&self, project_id: &str) -> Option<String> {
        let response = self
            .resources
            .bridge
            .get_json::<InstructionHashResponse>(&format!("/instructions/hash/{project_id}"))
            .await;

        match response {
            Ok(value) => Some(value.hash),
            Err(err) => {
                warn!(target: "pinksundew::sync", "[sync] Failed to fetch cloud hash: {err}");
                None
            }
        }
    }
}

pub struct BackgroundSyncOptions {
    pub project_id: String,
    pub workspace_root: PathBuf,
    pub interval: Duration,
    pub verbose: bool,
    pub panic_policy: PanicPolicy,
}

pub struct BackgroundSyncController {
    shutdown_tx: watch::Sender<bool>,
    join_handle: JoinHandle<()>,
}

impl BackgroundSyncController {
    pub async fn shutdown(self) {
        let _ = self.shutdown_tx.send(true);
        let _ = self.join_handle.await;
    }
}

pub fn start_background_sync_supervisor(
    sync_service: Arc<SyncService>,
    options: BackgroundSyncOptions,
) -> BackgroundSyncController {
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    let handle = tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);

        loop {
            tokio::select! {
                changed = shutdown_rx.changed() => {
                    if changed.is_ok() && *shutdown_rx.borrow() {
                        info!(target: "pinksundew::sync", "[sync] Background sync stopped");
                        break;
                    }
                }
                _ = tokio::time::sleep(options.interval) => {
                    let poll_cycle = std::panic::AssertUnwindSafe(run_poll_cycle(sync_service.clone(), &options)).catch_unwind().await;
                    match poll_cycle {
                        Ok(Ok(())) => {
                            backoff = Duration::from_secs(1);
                        }
                        Ok(Err(err)) => {
                            warn!(target: "pinksundew::sync", "[sync] Background sync cycle failed: {err}");
                        }
                        Err(payload) => {
                            let panic_message = panic_payload_to_string(payload);
                            error!(target: "pinksundew::sync", "[sync] Background sync panicked: {}", panic_message);

                            match options.panic_policy {
                                PanicPolicy::Supervise => {
                                    warn!(target: "pinksundew::sync", "[sync] Panic policy=supervise. Restarting background loop in {:?}", backoff);
                                    tokio::time::sleep(backoff).await;
                                    backoff = std::cmp::min(backoff * 2, Duration::from_secs(30));
                                    continue;
                                }
                                PanicPolicy::GracefulExit => {
                                    error!(target: "pinksundew::sync", "[sync] Panic policy=graceful_exit. Triggering controlled shutdown.");
                                    std::process::exit(1);
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    BackgroundSyncController {
        shutdown_tx,
        join_handle: handle,
    }
}

async fn run_poll_cycle(
    sync_service: Arc<SyncService>,
    options: &BackgroundSyncOptions,
) -> Result<()> {
    let local_hash = sync_service
        .read_local_hash(Some(options.workspace_root.clone()))
        .await;

    let cloud_hash = sync_service.fetch_cloud_hash(&options.project_id).await;
    let Some(cloud_hash) = cloud_hash else {
        return Ok(());
    };

    if local_hash.as_deref() == Some(cloud_hash.as_str()) {
        return Ok(());
    }

    if options.verbose {
        info!(target: "pinksundew::sync", "[sync] Hash mismatch detected, syncing...");
    }

    let result = sync_service
        .sync_global_instructions(Some(options.workspace_root.clone()), options.verbose)
        .await;

    if result.success {
        sync_service
            .save_local_hash(cloud_hash.as_str(), Some(options.workspace_root.clone()))
            .await;
        if options.verbose {
            info!(target: "pinksundew::sync", "[sync] Background sync complete: {} instruction(s)", result.instruction_count);
        }
    } else if options.verbose {
        warn!(target: "pinksundew::sync", "[sync] Background sync failed: {}", result.error.unwrap_or_else(|| "Unknown error".to_string()));
    }

    Ok(())
}

async fn fetch_active_instructions(
    resources: &ResourceService,
    project_id: &str,
) -> Result<(String, Vec<AgentInstructionSet>)> {
    let board_state = resources.get_board_state(project_id).await?;
    let mut active = board_state
        .instructions
        .into_iter()
        .filter(|instruction| {
            instruction.scope == "global" && instruction.is_active.unwrap_or(true)
        })
        .collect::<Vec<_>>();

    let file_ids = active
        .iter()
        .flat_map(|set| set.files.iter().map(|file| file.id.clone()))
        .collect::<Vec<_>>();

    if !file_ids.is_empty() {
        let files_with_content = resources
            .get_instruction_files_for_project(project_id, &file_ids)
            .await?;

        let mut content_map = std::collections::HashMap::new();
        for file in files_with_content {
            content_map.insert(file.id, file.content);
        }

        for set in &mut active {
            for file in &mut set.files {
                if let Some(content) = content_map.get(&file.id) {
                    file.content = content.clone();
                }
            }
        }
    }

    Ok((
        board_state
            .project
            .map(|project| project.name)
            .unwrap_or_else(|| "Unknown Project".to_string()),
        active,
    ))
}

fn collect_global_rule_content_blocks(instructions: &[AgentInstructionSet]) -> Vec<String> {
    let mut content_blocks = Vec::new();
    for instruction in instructions {
        let mut files = instruction.files.clone();
        files.sort_by(|a, b| a.file_name.cmp(&b.file_name));

        for file in files {
            if is_context_document(file.file_name.as_str()) {
                continue;
            }

            if let Some(content) = file.content {
                let trimmed = content.trim();
                if !trimmed.is_empty() {
                    content_blocks.push(trimmed.to_string());
                }
            }
        }
    }

    content_blocks
}

fn build_single_file_sync_block(
    global_rule_content_blocks: &[String],
    custom_documents: &[CustomInstructionDocument],
    project_name: &str,
    manifest_style: ManifestStyle,
) -> String {
    let mut content_blocks = global_rule_content_blocks.to_vec();

    if matches!(
        manifest_style,
        ManifestStyle::InlineAlwaysWithConditionalManifest
    ) {
        for document in custom_documents
            .iter()
            .filter(|document| matches!(document.routing.mode, InstructionRoutingMode::Always))
        {
            content_blocks.push(render_inline_custom_document(document));
        }
    }

    if !custom_documents.is_empty()
        && !content_blocks
            .iter()
            .any(|content| content.contains(CONTEXT_DOCS_NOTE))
    {
        content_blocks.push(CONTEXT_DOCS_NOTE.to_string());
    }

    let manifest_documents = match manifest_style {
        ManifestStyle::ReferenceOnly => custom_documents.iter().collect::<Vec<_>>(),
        ManifestStyle::InlineAlwaysWithConditionalManifest => custom_documents
            .iter()
            .filter(|document| !matches!(document.routing.mode, InstructionRoutingMode::Always))
            .collect::<Vec<_>>(),
    };

    if let Some(manifest) = render_conditional_document_manifest(&manifest_documents) {
        content_blocks.push(manifest);
    }

    let timestamp = Utc::now().to_rfc3339();
    let header = format!(
        "// AUTO-GENERATED BY PINK SUNDEW - DO NOT EDIT THIS BLOCK\n// Last synced: {}\n// Project: {}",
        timestamp, project_name
    );

    let inner_content = if content_blocks.is_empty() {
        "<!-- No active global instructions configured -->".to_string()
    } else {
        content_blocks.join("\n\n---\n\n")
    };

    format!("{SYNC_START}\n{header}\n\n{inner_content}\n{SYNC_END}")
}

fn is_context_document(file_name: &str) -> bool {
    file_name.replace('\\', "/").starts_with(CONTEXT_DOCS_DIR)
}

fn build_instruction_title_from_path(file_name: &str) -> String {
    let normalized_path = file_name.replace('\\', "/");
    let file_stem = normalized_path
        .strip_prefix(CONTEXT_DOCS_DIR)
        .unwrap_or(normalized_path.as_str())
        .strip_suffix(".md")
        .unwrap_or(normalized_path.as_str())
        .split('/')
        .filter(|segment| !segment.is_empty())
        .next_back()
        .unwrap_or("untitled-instruction");

    let normalized = file_stem
        .replace(['-', '_'], " ")
        .split_whitespace()
        .map(|segment| {
            let mut characters = segment.chars();
            let Some(first) = characters.next() else {
                return String::new();
            };

            let mut title = String::new();
            title.extend(first.to_uppercase());
            title.push_str(characters.as_str());
            title
        })
        .collect::<Vec<_>>()
        .join(" ");

    if normalized.trim().is_empty() {
        "Untitled Instruction".to_string()
    } else {
        normalized
    }
}

fn safe_context_document_path(file_name: &str) -> Option<String> {
    let normalized = file_name.replace('\\', "/");
    if !normalized.starts_with(CONTEXT_DOCS_DIR) || !normalized.ends_with(".md") {
        return None;
    }

    let path = Path::new(normalized.as_str());
    if path.is_absolute() {
        return None;
    }

    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return None;
    }

    Some(normalized)
}

fn collect_custom_instruction_documents(
    instructions: &[AgentInstructionSet],
) -> Vec<CustomInstructionDocument> {
    let mut documents = Vec::new();

    for instruction in instructions {
        let mut files = instruction.files.clone();
        files.sort_by(|a, b| a.file_name.cmp(&b.file_name));

        for file in files {
            let Some(relative_path) = safe_context_document_path(file.file_name.as_str()) else {
                continue;
            };
            let Some(content) = file.content else {
                continue;
            };

            let parsed = parse_instruction_document(content.as_str(), relative_path.as_str());
            let body = parsed.body.trim();
            if body.is_empty() {
                continue;
            }

            documents.push(CustomInstructionDocument {
                relative_path,
                body: body.to_string(),
                routing: parsed.routing,
            });
        }
    }

    documents
}

fn collect_context_documents(
    custom_documents: &[CustomInstructionDocument],
) -> Vec<(String, String)> {
    let mut documents = Vec::new();

    for document in custom_documents {
        let trimmed = document.body.trim();
        if trimmed.is_empty() {
            continue;
        }

        documents.push((document.relative_path.clone(), trimmed.to_string()));
    }

    documents
}

fn parse_instruction_document(content: &str, source_path: &str) -> ParsedInstructionDocument {
    let normalized = content.replace("\r\n", "\n");
    let default_title = build_instruction_title_from_path(source_path);
    let default = ParsedInstructionDocument {
        body: content.to_string(),
        routing: InstructionRoutingMetadata {
            title: default_title.clone(),
            mode: InstructionRoutingMode::Always,
            description: String::new(),
            globs: String::new(),
        },
    };

    let Some(frontmatter) = normalized.strip_prefix("---\n") else {
        return default;
    };
    let Some((raw_frontmatter, body)) = frontmatter.split_once("\n---\n") else {
        return default;
    };

    let mut title = default_title;
    let mut description = String::new();
    let mut globs = String::new();
    let mut routing_mode = None;
    let mut always_apply = false;

    for line in raw_frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "title" => {
                let parsed_title = parse_frontmatter_string(value);
                if !parsed_title.trim().is_empty() {
                    title = parsed_title;
                }
            }
            "description" => {
                description = parse_frontmatter_string(value);
            }
            "globs" => {
                globs = normalize_globs(parse_frontmatter_string(value).as_str());
            }
            "routingMode" => {
                routing_mode = match parse_frontmatter_string(value).as_str() {
                    "always" => Some(InstructionRoutingMode::Always),
                    "match-files" => Some(InstructionRoutingMode::MatchFiles),
                    "agent-decides" => Some(InstructionRoutingMode::AgentDecides),
                    _ => None,
                };
            }
            "alwaysApply" => {
                always_apply = value.trim() == "true";
            }
            _ => {}
        }
    }

    let mode = if let Some(mode) = routing_mode {
        mode
    } else if always_apply {
        InstructionRoutingMode::Always
    } else if !globs.is_empty() {
        InstructionRoutingMode::MatchFiles
    } else if !description.is_empty() {
        InstructionRoutingMode::AgentDecides
    } else {
        InstructionRoutingMode::Always
    };

    ParsedInstructionDocument {
        body: body.trim_start_matches('\n').to_string(),
        routing: InstructionRoutingMetadata {
            title,
            mode,
            description,
            globs,
        },
    }
}

fn parse_frontmatter_string(raw_value: &str) -> String {
    let trimmed = raw_value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    if trimmed.starts_with('"') {
        if let Ok(value) = serde_json::from_str::<String>(trimmed) {
            return value;
        }
    }

    if (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('\'') && trimmed.ends_with('\''))
    {
        return trimmed[1..trimmed.len().saturating_sub(1)].to_string();
    }

    trimmed.to_string()
}

fn normalize_globs(raw_value: &str) -> String {
    raw_value
        .split(',')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

async fn sync_cursor_rule_files(
    workspace_root: &Path,
    global_rule_content_blocks: &[String],
    custom_documents: &[CustomInstructionDocument],
    project_name: &str,
    verbose: bool,
) -> Result<Vec<String>> {
    cleanup_managed_cursor_rules(workspace_root, verbose).await?;

    let generated_files =
        build_cursor_rule_files(global_rule_content_blocks, custom_documents, project_name);
    if generated_files.is_empty() {
        return Ok(Vec::new());
    }

    let rules_dir = workspace_root.join(CURSOR_RULES_DIR);
    fs::create_dir_all(&rules_dir).await?;

    let mut files_written = Vec::new();
    for file in generated_files {
        let full_path = workspace_root.join(file.relative_path.as_str());
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::write(&full_path, format!("{}\n", file.content.trim_end())).await?;
        if verbose {
            info!(target: "pinksundew::sync", "[sync] Wrote {}", file.relative_path);
        }
        files_written.push(file.relative_path);
    }

    Ok(files_written)
}

async fn cleanup_managed_cursor_rules(workspace_root: &Path, verbose: bool) -> Result<()> {
    let legacy_cursor_file = workspace_root.join(LEGACY_CURSOR_RULE_FILE);
    let _ = remove_sync_block_if_present(&legacy_cursor_file, LEGACY_CURSOR_RULE_FILE, verbose).await;

    cleanup_managed_directory_files(
        workspace_root,
        CURSOR_RULES_DIR,
        CURSOR_MANAGED_RULE_PREFIX,
        ".mdc",
        verbose,
    )
    .await?;

    Ok(())
}

async fn sync_windsurf_rule_files(
    workspace_root: &Path,
    global_rule_content_blocks: &[String],
    custom_documents: &[CustomInstructionDocument],
    project_name: &str,
    verbose: bool,
) -> Result<Vec<String>> {
    cleanup_managed_windsurf_rules(workspace_root, verbose).await?;

    let generated_files =
        build_windsurf_rule_files(global_rule_content_blocks, custom_documents, project_name);
    if generated_files.is_empty() {
        return Ok(Vec::new());
    }

    let rules_dir = workspace_root.join(WINDSURF_RULES_DIR);
    fs::create_dir_all(&rules_dir).await?;

    let mut files_written = Vec::new();
    for file in generated_files {
        let full_path = workspace_root.join(file.relative_path.as_str());
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::write(&full_path, format!("{}\n", file.content.trim_end())).await?;
        if verbose {
            info!(target: "pinksundew::sync", "[sync] Wrote {}", file.relative_path);
        }
        files_written.push(file.relative_path);
    }

    Ok(files_written)
}

async fn cleanup_managed_windsurf_rules(workspace_root: &Path, verbose: bool) -> Result<()> {
    let legacy_windsurf_file = workspace_root.join(LEGACY_WINDSURF_RULE_FILE);
    let _ =
        remove_sync_block_if_present(&legacy_windsurf_file, LEGACY_WINDSURF_RULE_FILE, verbose)
            .await;

    cleanup_managed_directory_files(
        workspace_root,
        WINDSURF_RULES_DIR,
        WINDSURF_MANAGED_RULE_PREFIX,
        ".md",
        verbose,
    )
    .await?;

    Ok(())
}

async fn sync_copilot_instruction_files(
    workspace_root: &Path,
    global_rule_content_blocks: &[String],
    custom_documents: &[CustomInstructionDocument],
    project_name: &str,
    verbose: bool,
) -> Result<Vec<String>> {
    cleanup_managed_copilot_instructions(workspace_root, verbose).await?;

    let mut files_written = Vec::new();
    let root_sync_block = build_single_file_sync_block(
        global_rule_content_blocks,
        custom_documents,
        project_name,
        ManifestStyle::InlineAlwaysWithConditionalManifest,
    );
    let root_path = workspace_root.join(COPILOT_ROOT_FILE);
    write_instruction_file(&root_path, &root_sync_block).await?;
    if verbose {
        info!(target: "pinksundew::sync", "[sync] Wrote {}", COPILOT_ROOT_FILE);
    }
    files_written.push(COPILOT_ROOT_FILE.to_string());

    let generated_files = build_copilot_instruction_files(custom_documents, project_name);
    if generated_files.is_empty() {
        return Ok(files_written);
    }

    let instructions_dir = workspace_root.join(COPILOT_INSTRUCTIONS_DIR);
    fs::create_dir_all(&instructions_dir).await?;

    for file in generated_files {
        let full_path = workspace_root.join(file.relative_path.as_str());
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::write(&full_path, format!("{}\n", file.content.trim_end())).await?;
        if verbose {
            info!(target: "pinksundew::sync", "[sync] Wrote {}", file.relative_path);
        }
        files_written.push(file.relative_path);
    }

    Ok(files_written)
}

async fn cleanup_managed_copilot_instructions(
    workspace_root: &Path,
    verbose: bool,
) -> Result<()> {
    cleanup_managed_directory_files(
        workspace_root,
        COPILOT_INSTRUCTIONS_DIR,
        COPILOT_MANAGED_RULE_PREFIX,
        ".instructions.md",
        verbose,
    )
    .await?;

    Ok(())
}

async fn cleanup_managed_directory_files(
    workspace_root: &Path,
    rules_dir: &str,
    file_prefix: &str,
    extension: &str,
    verbose: bool,
) -> Result<()> {
    let rules_dir = workspace_root.join(rules_dir);
    let mut read_dir = match fs::read_dir(&rules_dir).await {
        Ok(handle) => handle,
        Err(_) => return Ok(()),
    };

    while let Some(entry) = read_dir.next_entry().await? {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !file_name.starts_with(file_prefix) || !file_name.ends_with(extension) {
            continue;
        }

        let _ = fs::remove_file(&path).await;
        if verbose {
            info!(
                target: "pinksundew::sync",
                "[sync] Removed {}",
                path.strip_prefix(workspace_root)
                    .ok()
                    .and_then(|value| value.to_str())
                    .unwrap_or(file_name)
            );
        }
    }

    Ok(())
}

async fn remove_sync_block_if_present(
    file_path: &Path,
    relative_path: &str,
    verbose: bool,
) -> Result<()> {
    let content = match fs::read_to_string(file_path).await {
        Ok(value) => value,
        Err(_) => return Ok(()),
    };

    let start_index = content.find(SYNC_START);
    let end_index = content.find(SYNC_END);
    let (Some(start), Some(end)) = (start_index, end_index) else {
        return Ok(());
    };

    let end_pos = end + SYNC_END.len();
    let mut cleaned = String::new();
    cleaned.push_str(&content[..start]);
    cleaned.push_str(&content[end_pos..]);

    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        let _ = fs::remove_file(file_path).await;
    } else {
        fs::write(file_path, format!("{}\n", cleaned)).await?;
    }

    if verbose {
        info!(
            target: "pinksundew::sync",
            "[sync] Removed managed sync block from {}",
            relative_path
        );
    }

    Ok(())
}

fn build_cursor_rule_files(
    global_rule_content_blocks: &[String],
    custom_documents: &[CustomInstructionDocument],
    project_name: &str,
) -> Vec<GeneratedTextFile> {
    let mut generated = Vec::new();
    let global_rules = global_rule_content_blocks.to_vec();

    if !global_rules.is_empty() {
        generated.push(GeneratedTextFile {
            relative_path: CURSOR_GLOBAL_RULE_FILE.to_string(),
            content: render_cursor_rule_file(
                project_name,
                "global instructions",
                &InstructionRoutingMetadata {
                    title: "Global Instructions".to_string(),
                    mode: InstructionRoutingMode::Always,
                    description: String::new(),
                    globs: String::new(),
                },
                global_rules.join("\n\n---\n\n").as_str(),
            ),
        });
    }

    let mut used_paths = HashSet::from([CURSOR_GLOBAL_RULE_FILE.to_string()]);

    for document in custom_documents {
        let cursor_path = build_managed_rule_path(
            document.relative_path.as_str(),
            CURSOR_RULES_DIR,
            CURSOR_MANAGED_RULE_PREFIX,
            ".mdc",
            &mut used_paths,
        );
        generated.push(GeneratedTextFile {
            relative_path: cursor_path,
            content: render_cursor_rule_file(
                project_name,
                document.relative_path.as_str(),
                &document.routing,
                document.body.as_str(),
            ),
        });
    }

    generated
}

fn build_windsurf_rule_files(
    global_rule_content_blocks: &[String],
    custom_documents: &[CustomInstructionDocument],
    project_name: &str,
) -> Vec<GeneratedTextFile> {
    let mut generated = Vec::new();
    if !global_rule_content_blocks.is_empty() {
        generated.push(GeneratedTextFile {
            relative_path: WINDSURF_GLOBAL_RULE_FILE.to_string(),
            content: render_windsurf_rule_file(
                project_name,
                "global instructions",
                &InstructionRoutingMetadata {
                    title: "Global Instructions".to_string(),
                    mode: InstructionRoutingMode::Always,
                    description: String::new(),
                    globs: String::new(),
                },
                global_rule_content_blocks.join("\n\n---\n\n").as_str(),
            ),
        });
    }

    let mut used_paths = HashSet::from([WINDSURF_GLOBAL_RULE_FILE.to_string()]);
    for document in custom_documents {
        let windsurf_path = build_managed_rule_path(
            document.relative_path.as_str(),
            WINDSURF_RULES_DIR,
            WINDSURF_MANAGED_RULE_PREFIX,
            ".md",
            &mut used_paths,
        );
        generated.push(GeneratedTextFile {
            relative_path: windsurf_path,
            content: render_windsurf_rule_file(
                project_name,
                document.relative_path.as_str(),
                &document.routing,
                document.body.as_str(),
            ),
        });
    }

    generated
}

fn build_copilot_instruction_files(
    custom_documents: &[CustomInstructionDocument],
    project_name: &str,
) -> Vec<GeneratedTextFile> {
    let mut generated = Vec::new();
    let mut used_paths = HashSet::new();

    for document in custom_documents
        .iter()
        .filter(|document| matches!(document.routing.mode, InstructionRoutingMode::MatchFiles))
    {
        let relative_path = build_managed_rule_path(
            document.relative_path.as_str(),
            COPILOT_INSTRUCTIONS_DIR,
            COPILOT_MANAGED_RULE_PREFIX,
            ".instructions.md",
            &mut used_paths,
        );
        generated.push(GeneratedTextFile {
            relative_path,
            content: render_copilot_instruction_file(
                project_name,
                document.relative_path.as_str(),
                &document.routing,
                document.body.as_str(),
            ),
        });
    }

    generated
}

fn build_managed_rule_path(
    relative_path: &str,
    target_dir: &str,
    managed_prefix: &str,
    extension: &str,
    used_paths: &mut HashSet<String>,
) -> String {
    let normalized = relative_path
        .strip_prefix(CONTEXT_DOCS_DIR)
        .unwrap_or(relative_path)
        .strip_suffix(".md")
        .unwrap_or(relative_path);

    let slug = normalized
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    let slug = if slug.is_empty() {
        "context".to_string()
    } else {
        slug
    };

    let base_path = format!("{target_dir}/{managed_prefix}{slug}{extension}");
    if used_paths.insert(base_path.clone()) {
        return base_path;
    }

    let hashed = format!(
        "{target_dir}/{managed_prefix}{slug}-{:08x}{extension}",
        stable_managed_rule_hash(relative_path)
    );
    used_paths.insert(hashed.clone());
    hashed
}

fn stable_managed_rule_hash(value: &str) -> u32 {
    let mut hash = 0_u32;
    for byte in value.bytes() {
        hash = hash.wrapping_mul(31).wrapping_add(u32::from(byte));
    }
    hash
}

fn render_cursor_rule_file(
    project_name: &str,
    source_path: &str,
    metadata: &InstructionRoutingMetadata,
    body: &str,
) -> String {
    let description = match metadata.mode {
        InstructionRoutingMode::AgentDecides => metadata.description.trim(),
        _ => "",
    };
    let globs = match metadata.mode {
        InstructionRoutingMode::MatchFiles => metadata.globs.trim(),
        _ => "",
    };
    let timestamp = Utc::now().to_rfc3339();
    let header = format!(
        "<!-- AUTO-GENERATED BY PINK SUNDEW - DO NOT EDIT THIS FILE DIRECTLY.\nLast synced: {timestamp}\nProject: {project_name}\nSource: {source_path}\n-->"
    );

    format!(
        "---\ndescription: {}\nglobs: {}\nalwaysApply: {}\n---\n\n{}\n\n{}",
        serde_json::to_string(description).unwrap_or_else(|_| "\"\"".to_string()),
        serde_json::to_string(globs).unwrap_or_else(|_| "\"\"".to_string()),
        matches!(metadata.mode, InstructionRoutingMode::Always),
        header,
        body.trim()
    )
}

fn render_windsurf_rule_file(
    project_name: &str,
    source_path: &str,
    metadata: &InstructionRoutingMetadata,
    body: &str,
) -> String {
    let trigger = match metadata.mode {
        InstructionRoutingMode::Always => "always_on",
        InstructionRoutingMode::MatchFiles => "glob",
        InstructionRoutingMode::AgentDecides => "model_decision",
    };
    let timestamp = Utc::now().to_rfc3339();
    let header = format!(
        "<!-- AUTO-GENERATED BY PINK SUNDEW - DO NOT EDIT THIS FILE DIRECTLY.\nLast synced: {timestamp}\nProject: {project_name}\nSource: {source_path}\n-->"
    );
    let mut lines = vec!["---".to_string(), format!("trigger: {trigger}")];
    if matches!(metadata.mode, InstructionRoutingMode::MatchFiles) {
        lines.push(format!(
            "globs: {}",
            serde_json::to_string(metadata.globs.trim()).unwrap_or_else(|_| "\"\"".to_string())
        ));
    }
    if matches!(metadata.mode, InstructionRoutingMode::AgentDecides) {
        lines.push(format!(
            "description: {}",
            serde_json::to_string(metadata.description.trim())
                .unwrap_or_else(|_| "\"\"".to_string())
        ));
    }
    lines.push("---".to_string());
    lines.push(String::new());
    lines.push(header);
    lines.push(String::new());
    lines.push(body.trim().to_string());
    lines.join("\n")
}

fn render_copilot_instruction_file(
    project_name: &str,
    source_path: &str,
    metadata: &InstructionRoutingMetadata,
    body: &str,
) -> String {
    let timestamp = Utc::now().to_rfc3339();
    let header = format!(
        "<!-- AUTO-GENERATED BY PINK SUNDEW - DO NOT EDIT THIS FILE DIRECTLY.\nLast synced: {timestamp}\nProject: {project_name}\nSource: {source_path}\n-->"
    );

    format!(
        "---\napplyTo: {}\n---\n\n{}\n\n{}",
        serde_json::to_string(metadata.globs.trim()).unwrap_or_else(|_| "\"\"".to_string()),
        header,
        body.trim()
    )
}

fn render_inline_custom_document(document: &CustomInstructionDocument) -> String {
    format!(
        "### {}\nSource: `{}`\n\n{}",
        document.routing.title.trim(),
        document.relative_path,
        document.body.trim()
    )
}

fn render_conditional_document_manifest(
    custom_documents: &[&CustomInstructionDocument],
) -> Option<String> {
    if custom_documents.is_empty() {
        return None;
    }

    let mut lines = vec![
        format!("### {CONDITIONAL_DOCS_HEADING}"),
        "When a task matches one of the conditions below, read the referenced context document before making changes.".to_string(),
    ];

    for document in custom_documents {
        let condition = match document.routing.mode {
            InstructionRoutingMode::Always => "Always on.".to_string(),
            InstructionRoutingMode::MatchFiles => format!(
                "Read when touching files matching `{}`.",
                document.routing.globs.trim()
            ),
            InstructionRoutingMode::AgentDecides => {
                let description = document.routing.description.trim();
                if description.is_empty() {
                    format!(
                        "Read when `{}` is relevant to the task.",
                        document.routing.title.trim()
                    )
                } else {
                    description.to_string()
                }
            }
        };
        lines.push(format!(
            "- {} (`{}`): {}",
            document.routing.title.trim(),
            document.relative_path,
            condition
        ));
    }

    Some(lines.join("\n"))
}

fn replace_sync_block(existing: &str, sync_block: &str) -> String {
    let start_index = existing.find(SYNC_START);
    let end_index = existing.find(SYNC_END);

    match (start_index, end_index) {
        (Some(start), Some(end)) if end >= start => {
            let end_pos = end + SYNC_END.len();
            let mut output = String::new();
            output.push_str(&existing[..start]);
            output.push_str(sync_block);
            output.push_str(&existing[end_pos..]);
            output
        }
        _ => {
            let spacing = if existing.ends_with("\n\n") {
                ""
            } else if existing.ends_with('\n') {
                "\n"
            } else {
                "\n\n"
            };
            format!("{}{}{}\n", existing, spacing, sync_block)
        }
    }
}

async fn write_instruction_file(file_path: &Path, sync_block: &str) -> Result<()> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    let content = match fs::read_to_string(file_path).await {
        Ok(existing) => replace_sync_block(&existing, sync_block),
        Err(_) => format!("{}\n", sync_block),
    };

    fs::write(file_path, content).await?;
    Ok(())
}

async fn write_context_document(file_path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    fs::write(file_path, format!("{}\n", content.trim())).await?;
    Ok(())
}

pub fn get_output_file_paths(board_targets: &[String]) -> Vec<String> {
    dedupe(board_targets)
}

fn dedupe(items: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut output = Vec::new();

    for item in items {
        if seen.insert(item.clone()) {
            output.push(item.clone());
        }
    }

    output
}

fn panic_payload_to_string(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&'static str>() {
        return (*message).to_string();
    }

    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }

    "Unknown panic payload".to_string()
}

#[expect(
    dead_code,
    reason = "cleanup path is part of the MCP migration surface but not wired yet"
)]
pub async fn cleanup_instruction_files(
    scope: &ProjectScope,
    workspace_root: Option<PathBuf>,
    verbose: bool,
) -> Vec<String> {
    let workspace_root = workspace_root
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let mut files_cleaned = Vec::new();

    let all_files = vec![
        LEGACY_CURSOR_RULE_FILE.to_string(),
        CURSOR_GLOBAL_RULE_FILE.to_string(),
        "CLAUDE.md".to_string(),
        ".windsurfrules".to_string(),
        ".github/copilot-instructions.md".to_string(),
        "AGENTS.md".to_string(),
        "antigravity.md".to_string(),
    ];
    let _ = scope;
    let all_files = dedupe(&all_files);

    for relative_path in all_files {
        let full_path = workspace_root.join(relative_path.as_str());

        let content = match fs::read_to_string(&full_path).await {
            Ok(value) => value,
            Err(_) => continue,
        };

        let start_index = content.find(SYNC_START);
        let end_index = content.find(SYNC_END);
        let (Some(start), Some(end)) = (start_index, end_index) else {
            if verbose {
                info!(target: "pinksundew::sync", "[sync] Skipped {} (no sync block found)", relative_path);
            }
            continue;
        };

        let end_pos = end + SYNC_END.len();
        let mut cleaned = String::new();
        cleaned.push_str(&content[..start]);
        cleaned.push_str(&content[end_pos..]);

        let cleaned = cleaned.trim().to_string();
        if cleaned.is_empty() {
            if fs::remove_file(&full_path).await.is_ok() {
                files_cleaned.push(relative_path.clone());
                if verbose {
                    info!(target: "pinksundew::sync", "[sync] Deleted {} (was only sync block)", relative_path);
                }
            }
        } else if fs::write(&full_path, format!("{}\n", cleaned))
            .await
            .is_ok()
        {
            files_cleaned.push(relative_path.clone());
            if verbose {
                info!(target: "pinksundew::sync", "[sync] Removed sync block from {}", relative_path);
            }
        }
    }

    files_cleaned
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AgentInstructionFile;
    use pretty_assertions::assert_eq;

    #[test]
    fn output_file_paths_use_board_targets_without_default_fallback() {
        let result = get_output_file_paths(&[
            "AGENTS.md".to_string(),
            ".github/copilot-instructions.md".to_string(),
        ]);
        assert_eq!(
            result,
            vec![
                "AGENTS.md".to_string(),
                ".github/copilot-instructions.md".to_string()
            ]
        );

        let empty = get_output_file_paths(&[]);
        assert!(empty.is_empty());
    }

    #[test]
    fn replace_sync_block_appends_when_missing() {
        let existing = "# User instructions\n\nStay concise.\n";
        let sync = "<!-- BEGIN:pinksundew-sync -->\nhello\n<!-- END:pinksundew-sync -->";
        let result = replace_sync_block(existing, sync);
        assert!(result.contains(sync));
        assert!(result.starts_with("# User instructions"));
    }

    #[test]
    fn replace_sync_block_replaces_existing_region_only() {
        let existing =
            "before\n<!-- BEGIN:pinksundew-sync -->\nold\n<!-- END:pinksundew-sync -->\nafter\n";
        let sync = "<!-- BEGIN:pinksundew-sync -->\nnew\n<!-- END:pinksundew-sync -->";
        let result = replace_sync_block(existing, sync);
        assert_eq!(
            result,
            "before\n<!-- BEGIN:pinksundew-sync -->\nnew\n<!-- END:pinksundew-sync -->\nafter\n"
        );
    }

    #[test]
    fn single_file_sync_block_inlines_always_docs_and_lists_conditionals() {
        let instructions = vec![AgentInstructionSet {
            id: "set-1".to_string(),
            project_id: None,
            name: "Workspace".to_string(),
            code: "workspace".to_string(),
            scope: "global".to_string(),
            description: None,
            sort_order: None,
            is_active: Some(true),
            created_at: None,
            updated_at: None,
            files: vec![
                AgentInstructionFile {
                    id: "rules".to_string(),
                    set_id: "set-1".to_string(),
                    file_name: "agent-rules.md".to_string(),
                    content_hash: "rules-hash".to_string(),
                    updated_at: "2026-04-20T00:00:00Z".to_string(),
                    created_at: None,
                    content: Some("Always read the task thread first.".to_string()),
                },
                AgentInstructionFile {
                    id: "context".to_string(),
                    set_id: "set-1".to_string(),
                    file_name: ".pinksundew/docs/architecture.md".to_string(),
                    content_hash: "context-hash".to_string(),
                    updated_at: "2026-04-20T00:00:00Z".to_string(),
                    created_at: None,
                    content: Some(
                        "---\ntitle: \"Architecture\"\nroutingMode: \"agent-decides\"\ndescription: \"Use when editing architecture flows.\"\nglobs: \"\"\n---\n\n# Architecture\n\nDetails".to_string(),
                    ),
                },
            ],
        }];

        let global_rules = collect_global_rule_content_blocks(&instructions);
        let custom_documents = collect_custom_instruction_documents(&instructions);
        let result = build_single_file_sync_block(
            &global_rules,
            &custom_documents,
            "Pink Sundew",
            ManifestStyle::InlineAlwaysWithConditionalManifest,
        );

        assert!(result.contains("Always read the task thread first."));
        assert!(result.contains(CONTEXT_DOCS_NOTE));
        assert!(result.contains(CONDITIONAL_DOCS_HEADING));
        assert!(result.contains(".pinksundew/docs/architecture.md"));
    }

    #[test]
    fn collect_custom_instruction_documents_keeps_safe_markdown_paths_only() {
        let instructions = vec![AgentInstructionSet {
            id: "set-1".to_string(),
            project_id: None,
            name: "Workspace".to_string(),
            code: "workspace".to_string(),
            scope: "global".to_string(),
            description: None,
            sort_order: None,
            is_active: Some(true),
            created_at: None,
            updated_at: None,
            files: vec![
                AgentInstructionFile {
                    id: "context".to_string(),
                    set_id: "set-1".to_string(),
                    file_name: ".pinksundew/docs/database-schema.md".to_string(),
                    content_hash: "context-hash".to_string(),
                    updated_at: "2026-04-20T00:00:00Z".to_string(),
                    created_at: None,
                    content: Some(
                        "---\ndescription: \"Use when working on database schema changes.\"\nglobs: \"src/**/*.ts\"\nalwaysApply: false\n---\n\n# Schema".to_string(),
                    ),
                },
                AgentInstructionFile {
                    id: "unsafe".to_string(),
                    set_id: "set-1".to_string(),
                    file_name: ".pinksundew/docs/../secret.md".to_string(),
                    content_hash: "unsafe-hash".to_string(),
                    updated_at: "2026-04-20T00:00:00Z".to_string(),
                    created_at: None,
                    content: Some("nope".to_string()),
                },
            ],
        }];

        assert_eq!(
            collect_custom_instruction_documents(&instructions),
            vec![CustomInstructionDocument {
                relative_path: ".pinksundew/docs/database-schema.md".to_string(),
                body: "# Schema".to_string(),
                routing: InstructionRoutingMetadata {
                    title: "Database Schema".to_string(),
                    mode: InstructionRoutingMode::MatchFiles,
                    description: "Use when working on database schema changes.".to_string(),
                    globs: "src/**/*.ts".to_string(),
                },
            }]
        );
    }

    #[test]
    fn build_cursor_rule_files_generates_project_rules_and_skips_context_note() {
        let instructions = vec![AgentInstructionSet {
            id: "set-1".to_string(),
            project_id: None,
            name: "Workspace".to_string(),
            code: "workspace".to_string(),
            scope: "global".to_string(),
            description: None,
            sort_order: None,
            is_active: Some(true),
            created_at: None,
            updated_at: None,
            files: vec![
                AgentInstructionFile {
                    id: "rules".to_string(),
                    set_id: "set-1".to_string(),
                    file_name: "agent-rules.md".to_string(),
                    content_hash: "rules-hash".to_string(),
                    updated_at: "2026-04-20T00:00:00Z".to_string(),
                    created_at: None,
                    content: Some("Always read the task thread first.".to_string()),
                },
                AgentInstructionFile {
                    id: "context".to_string(),
                    set_id: "set-1".to_string(),
                    file_name: ".pinksundew/docs/architecture.md".to_string(),
                    content_hash: "context-hash".to_string(),
                    updated_at: "2026-04-20T00:00:00Z".to_string(),
                    created_at: None,
                    content: Some(
                        "---\ndescription: \"Use when editing architecture flows.\"\nglobs: \"\"\nalwaysApply: false\n---\n\n# Architecture\n\nDetails".to_string(),
                    ),
                },
            ],
        }];

        let global_rules = collect_global_rule_content_blocks(&instructions);
        let custom_documents = collect_custom_instruction_documents(&instructions);
        let files = build_cursor_rule_files(&global_rules, &custom_documents, "Pink Sundew");

        assert_eq!(files.len(), 2);
        assert_eq!(files[0].relative_path, CURSOR_GLOBAL_RULE_FILE);
        assert!(files[0].content.contains("Always read the task thread first."));
        assert!(!files[0].content.contains(CONTEXT_DOCS_NOTE));
        assert!(files[1]
            .relative_path
            .starts_with(".cursor/rules/pinksundew-architecture"));
        assert!(files[1].content.contains("alwaysApply: false"));
        assert!(files[1]
            .content
            .contains("description: \"Use when editing architecture flows.\""));
        assert!(files[1].content.contains("# Architecture"));
    }

    #[test]
    fn build_windsurf_rule_files_maps_trigger_types() {
        let documents = vec![CustomInstructionDocument {
            relative_path: ".pinksundew/docs/tests.md".to_string(),
            body: "Use shared test helpers.".to_string(),
            routing: InstructionRoutingMetadata {
                title: "Tests".to_string(),
                mode: InstructionRoutingMode::MatchFiles,
                description: String::new(),
                globs: "**/*.test.ts".to_string(),
            },
        }];

        let files = build_windsurf_rule_files(&[], &documents, "Pink Sundew");

        assert_eq!(files.len(), 1);
        assert!(files[0].relative_path.starts_with(".windsurf/rules/pinksundew-tests"));
        assert!(files[0].content.contains("trigger: glob"));
        assert!(files[0].content.contains("globs: \"**/*.test.ts\""));
    }

    #[test]
    fn build_copilot_instruction_files_only_includes_match_file_documents() {
        let documents = vec![
            CustomInstructionDocument {
                relative_path: ".pinksundew/docs/backend.md".to_string(),
                body: "Backend rules".to_string(),
                routing: InstructionRoutingMetadata {
                    title: "Backend".to_string(),
                    mode: InstructionRoutingMode::MatchFiles,
                    description: String::new(),
                    globs: "src/backend/**/*.ts".to_string(),
                },
            },
            CustomInstructionDocument {
                relative_path: ".pinksundew/docs/product.md".to_string(),
                body: "Product notes".to_string(),
                routing: InstructionRoutingMetadata {
                    title: "Product".to_string(),
                    mode: InstructionRoutingMode::AgentDecides,
                    description: "Use when working on product copy.".to_string(),
                    globs: String::new(),
                },
            },
        ];

        let files = build_copilot_instruction_files(&documents, "Pink Sundew");

        assert_eq!(files.len(), 1);
        assert!(files[0]
            .relative_path
            .starts_with(".github/instructions/pinksundew-backend"));
        assert!(files[0].content.contains("applyTo: \"src/backend/**/*.ts\""));
        assert!(!files[0].content.contains("Product notes"));
    }

    #[tokio::test]
    async fn write_instruction_file_creates_file_and_directories() {
        let temp = tempfile::tempdir().expect("tempdir");
        let nested = temp.path().join(".github/copilot-instructions.md");
        let sync = "<!-- BEGIN:pinksundew-sync -->\nblock\n<!-- END:pinksundew-sync -->";
        write_instruction_file(nested.as_path(), sync)
            .await
            .expect("write should succeed");

        let content = fs::read_to_string(nested)
            .await
            .expect("content should exist");
        assert!(content.contains(sync));
    }
}
