use crate::arg_parse::as_object;
use crate::config::ProjectScope;
use crate::models::AgentControls;
use crate::panic_guard::guard_request_panic;
use crate::resources::ResourceService;
use crate::sync::SyncService;
use crate::tools::ToolService;
use crate::update::UpdateService;
use rmcp::{
    model::{
        Annotated, CallToolRequestParams, CallToolResult, Content, ListResourcesResult,
        ListToolsResult, RawResource, ReadResourceRequestParams, ReadResourceResult,
        ResourceContents, ServerCapabilities, ServerInfo, Tool,
    },
    service::{RequestContext, RoleServer},
    ErrorData as McpError, ServerHandler,
};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::Arc;

const SERVER_NAME: &str = "pinksundew-mcp";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
pub struct PinkSundewServer {
    pub resources: ResourceService,
    pub tools: ToolService,
    pub sync: Arc<SyncService>,
    pub updates: Arc<UpdateService>,
    pub scope: ProjectScope,
    tool_defs: Arc<Vec<ToolDefinition>>,
    project_scoped_tools: Arc<HashSet<&'static str>>,
}

#[derive(Debug, Clone)]
struct ToolDefinition {
    name: &'static str,
    description: &'static str,
    input_schema: Value,
}

impl PinkSundewServer {
    pub fn new(
        resources: ResourceService,
        tools: ToolService,
        sync: Arc<SyncService>,
        updates: Arc<UpdateService>,
        scope: ProjectScope,
    ) -> Self {
        Self {
            resources,
            tools,
            sync,
            updates,
            scope,
            tool_defs: Arc::new(tool_definitions()),
            project_scoped_tools: Arc::new(project_scoped_tool_names()),
        }
    }

    async fn execute_call_tool(
        &self,
        request: CallToolRequestParams,
    ) -> Result<CallToolResult, McpError> {
        let tool_name = request.name.to_string();
        let args = request
            .arguments
            .map(Value::Object)
            .unwrap_or_else(|| Value::Object(Default::default()));

        if self.project_scoped_tools.contains(tool_name.as_str()) {
            let project_id = self
                .resolve_project_id_for_tool(&tool_name, &args)
                .await
                .map_err(invalid_params_error)?;
            let controls = self
                .resources
                .get_project_agent_controls(project_id.as_str())
                .await
                .map_err(internal_error)?;

            if !is_tool_enabled(&controls, &tool_name) {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: Tool {} is disabled for this project in Agent Controls.",
                    tool_name
                ))]));
            }

            if tool_name == "move_task" {
                let status = as_object(&args)
                    .and_then(|map| {
                        map.get("status")
                            .and_then(Value::as_str)
                            .map(|s| s.to_string())
                            .ok_or_else(|| anyhow::anyhow!("status must be a string"))
                    })
                    .map_err(invalid_params_error)?;

                if status == "done" && !controls.allow_task_completion {
                    return Ok(CallToolResult::error(vec![Content::text(
                        "Error: Task completion is disabled for this project. Enable \"Allow Task Completion\" in Agent Controls to move tasks to done.".to_string(),
                    )]));
                }
            }

            if tool_name == "create_task" {
                let requested_status = as_object(&args)
                    .ok()
                    .and_then(|map| map.get("status"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string);

                if requested_status.as_deref() == Some("done") && !controls.allow_task_completion {
                    return Ok(CallToolResult::error(vec![Content::text(
                        "Error: Task completion is disabled for this project. Enable \"Allow Task Completion\" in Agent Controls to create done tasks.".to_string(),
                    )]));
                }
            }
        }

        let tool_result: anyhow::Result<Value> = match tool_name.as_str() {
            "list_projects" => self.tools.list_projects().await,
            "get_project_board" => self.tools.get_project_board().await,
            "get_task_details" => {
                let task_id = required_str_arg(&args, "taskId").map_err(invalid_params_error)?;
                self.tools.get_task(task_id).await
            }
            "list_abyss_tasks" => self.tools.list_abyss_tasks().await,
            "list_project_tags" => self.tools.list_tags().await,
            "create_task" => self.tools.create_task(args.clone()).await,
            "update_task" => self.tools.update_task(args.clone()).await,
            "move_task" => self.tools.move_task(args.clone()).await,
            "set_task_signal" => self.tools.set_task_signal(args.clone()).await,
            "list_task_messages" => self.tools.list_task_messages(args.clone()).await,
            "add_task_message" => self.tools.add_task_message(args.clone()).await,
            "move_task_to_abyss" => self.tools.move_task_to_abyss(args.clone()).await,
            "restore_task" => self.tools.restore_task(args.clone()).await,
            "add_plan_to_task" => self.tools.add_plan_to_task(args.clone()).await,
            "create_tag" => self.tools.create_tag(args.clone()).await,
            "delete_tag" => self.tools.delete_tag(args.clone()).await,
            "export_tasks" => self.tools.export_tasks(args.clone()).await,
            "sync_global_instructions" => {
                let result = self.sync.sync_global_instructions(None, false).await;
                if result.success {
                    let mut value = json!(result);

                    let update_status = self.updates.current_status().await;
                    if let Some(map) = value.as_object_mut() {
                        map.insert("updateStatus".to_string(), json!(update_status));
                    }

                    Ok(value)
                } else {
                    Err(anyhow::anyhow!(
                        "{}",
                        result
                            .error
                            .unwrap_or_else(|| "Failed to sync instructions".to_string())
                    ))
                }
            }
            "get_update_status" => {
                let _ = self.updates.refresh_if_stale().await;
                let status = self.updates.current_status().await;
                serde_json::to_value(status).map_err(Into::into)
            }
            _ => {
                return Ok(CallToolResult::error(vec![Content::text(format!(
                    "Error: Unknown tool: {}",
                    tool_name
                ))]))
            }
        };

        match tool_result {
            Ok(value) => {
                let text =
                    serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
                Ok(CallToolResult::success(vec![Content::text(text)]))
            }
            Err(error) => Ok(CallToolResult::error(vec![Content::text(format!(
                "Error: {}",
                error
            ))])),
        }
    }

    async fn resolve_project_id_for_tool(
        &self,
        tool_name: &str,
        args: &Value,
    ) -> anyhow::Result<String> {
        match tool_name {
            "get_project_board" | "list_abyss_tasks" | "list_project_tags" | "create_task"
            | "create_tag" | "export_tasks" => Ok(self.scope.project_id().to_string()),
            "get_task_details" | "update_task" | "move_task" | "set_task_signal"
            | "list_task_messages" | "add_task_message" | "move_task_to_abyss" | "restore_task"
            | "add_plan_to_task" => {
                let task_id = required_str_arg(args, "taskId")?;
                let task = self.resources.get_task_details(task_id).await?;
                Ok(task.project_id)
            }
            "delete_tag" => {
                let tag_id = required_str_arg(args, "tagId")?;
                let tag = self.resources.get_tag_details(tag_id).await?;
                Ok(tag.project_id)
            }
            _ => Err(anyhow::anyhow!(
                "Unable to resolve project for tool {}",
                tool_name
            )),
        }
    }
}

impl ServerHandler for PinkSundewServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(rmcp::model::Implementation::new(
            SERVER_NAME,
            SERVER_VERSION,
        ))
        .with_instructions(format!(
            "Pink Sundew MCP server for linked project {} ({}). Runtime: {} {}",
            self.scope.project_name(),
            self.scope.project_id(),
            SERVER_NAME,
            SERVER_VERSION
        ))
    }

    async fn list_resources(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        guard_request_panic("resources/list", async {
            let projects = self
                .resources
                .get_projects()
                .await
                .map_err(internal_error)?;
            let resources = projects
                .into_iter()
                .flat_map(|project| {
                    vec![
                        Annotated::new(
                            RawResource::new(
                                format!("pinksundew://board/{}", project.id),
                                format!("Board: {}", project.name),
                            )
                            .with_mime_type("application/json")
                            .with_description(format!("Visible board state for {}", project.name)),
                            None,
                        ),
                        Annotated::new(
                            RawResource::new(
                                format!("pinksundew://abyss/{}", project.id),
                                format!("Abyss: {}", project.name),
                            )
                            .with_mime_type("application/json")
                            .with_description(format!(
                                "Deleted and archived tasks for {}",
                                project.name
                            )),
                            None,
                        ),
                    ]
                })
                .collect::<Vec<_>>();

            Ok(ListResourcesResult::with_all_items(resources))
        })
        .await
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        guard_request_panic("resources/read", async {
            let url = url::Url::parse(request.uri.as_str()).map_err(invalid_params_error)?;

            if url.scheme() != "pinksundew" {
                return Err(invalid_params_error(anyhow::anyhow!(
                    "Unknown resource uri: {}",
                    request.uri
                )));
            }

            let host = url.host_str().unwrap_or_default();
            let id = url.path().trim_start_matches('/');

            match host {
                "board" => {
                    self.scope
                        .assert_project_allowed(id, Some("ReadResource:board"))
                        .map_err(invalid_params_error)?;

                    let mut board = self
                        .resources
                        .get_board_state(id)
                        .await
                        .map_err(internal_error)?;

                    for instruction_set in &mut board.instructions {
                        for file in &mut instruction_set.files {
                            file.content = None;
                        }
                    }

                    let text = serde_json::to_string_pretty(&board).map_err(internal_error)?;
                    Ok(ReadResourceResult::new(vec![ResourceContents::text(
                        text,
                        request.uri.clone(),
                    )
                    .with_mime_type("application/json")]))
                }
                "abyss" => {
                    self.scope
                        .assert_project_allowed(id, Some("ReadResource:abyss"))
                        .map_err(invalid_params_error)?;

                    let abyss = self
                        .resources
                        .get_abyss_state(id)
                        .await
                        .map_err(internal_error)?;
                    let text = serde_json::to_string_pretty(&abyss).map_err(internal_error)?;

                    Ok(ReadResourceResult::new(vec![ResourceContents::text(
                        text,
                        request.uri.clone(),
                    )
                    .with_mime_type("application/json")]))
                }
                "task" => {
                    let task = self
                        .resources
                        .get_task_details(id)
                        .await
                        .map_err(internal_error)?;
                    let text = serde_json::to_string_pretty(&task).map_err(internal_error)?;

                    Ok(ReadResourceResult::new(vec![ResourceContents::text(
                        text,
                        request.uri.clone(),
                    )
                    .with_mime_type("application/json")]))
                }
                _ => Err(invalid_params_error(anyhow::anyhow!(
                    "Unknown resource uri: {}",
                    request.uri
                ))),
            }
        })
        .await
    }

    async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let tools = self
            .tool_defs
            .iter()
            .map(|definition| {
                Tool::new(
                    definition.name,
                    definition.description,
                    schema_object(definition.input_schema.clone()),
                )
            })
            .collect::<Vec<_>>();

        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        guard_request_panic("tools/call", self.execute_call_tool(request)).await
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.tool_defs.iter().find_map(|definition| {
            if definition.name == name {
                Some(Tool::new(
                    definition.name,
                    definition.description,
                    schema_object(definition.input_schema.clone()),
                ))
            } else {
                None
            }
        })
    }
}

fn tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "list_projects",
            description: "Returns the single Pink Sundew project linked to the current workspace.",
            input_schema: json!({"type":"object","properties":{},"additionalProperties":false}),
        },
        ToolDefinition {
            name: "get_project_board",
            description: "Returns the current visible board state for the linked workspace project, including tasks, tags, and instruction sets.",
            input_schema: json!({"type":"object","properties":{},"additionalProperties":false}),
        },
        ToolDefinition {
            name: "get_task_details",
            description: "Returns a task with tags, plans, timeline, linked instruction sets, and resolved instruction content.",
            input_schema: json!({"type":"object","properties":{"taskId":{"type":"string"}},"required":["taskId"]}),
        },
        ToolDefinition {
            name: "list_abyss_tasks",
            description: "Lists deleted and archived tasks for the linked workspace project.",
            input_schema: json!({"type":"object","properties":{},"additionalProperties":false}),
        },
        ToolDefinition {
            name: "list_project_tags",
            description: "Lists the tags configured for the linked workspace project.",
            input_schema: json!({"type":"object","properties":{},"additionalProperties":false}),
        },
        ToolDefinition {
            name: "create_task",
            description: "Creates a new task in the linked workspace project. Use predecessorId to create a follow-up ticket instead of subtasks.",
            input_schema: json!({
                "type":"object",
                "properties":{
                    "title":{"type":"string"},
                    "description":{"type":"string"},
                    "status":{"type":"string","enum":["todo","in-progress","done"]},
                    "priority":{"type":"string","enum":["low","medium","high"]},
                    "assigneeId":{"type":["string","null"]},
                    "dueDate":{"type":["string","null"]},
                    "predecessorId":{"type":["string","null"]},
                    "position":{"type":"number"}
                },
                "required":["title"],
                "additionalProperties":false
            }),
        },
        ToolDefinition {
            name: "update_task",
            description: "Updates task details other than board stage movement.",
            input_schema: json!({
                "type":"object",
                "properties":{
                    "taskId":{"type":"string"},
                    "title":{"type":"string"},
                    "description":{"type":["string","null"]},
                    "priority":{"type":"string","enum":["low","medium","high"]},
                    "assigneeId":{"type":["string","null"]},
                    "dueDate":{"type":["string","null"]},
                    "predecessorId":{"type":["string","null"]}
                },
                "required":["taskId"]
            }),
        },
        ToolDefinition {
            name: "move_task",
            description: "Moves a task between board stages and optionally updates its position within the destination column. Completion behavior is controlled by project Agent Controls.",
            input_schema: json!({"type":"object","properties":{"taskId":{"type":"string"},"status":{"type":"string","enum":["todo","in-progress","done"]},"position":{"type":"number"}},"required":["taskId","status"]}),
        },
        ToolDefinition {
            name: "set_task_signal",
            description: "Sets or clears workflow overlays on a task (ready_for_review, needs_help, or agent_working), with optional lock metadata for AI ownership windows.",
            input_schema: json!({
                "type":"object",
                "properties":{
                    "taskId":{"type":"string"},
                    "signal":{"anyOf":[{"type":"string","enum":["ready_for_review","needs_help","agent_working"]},{"type":"null"}]},
                    "message":{"type":["string","null"]},
                    "lockMinutes":{"type":"number"},
                    "lockReason":{"type":["string","null"]}
                },
                "required":["taskId"]
            }),
        },
        ToolDefinition {
            name: "list_task_messages",
            description: "Lists workflow signal messages for a task (most recent first).",
            input_schema: json!({"type":"object","properties":{"taskId":{"type":"string"},"limit":{"type":"number"}},"required":["taskId"]}),
        },
        ToolDefinition {
            name: "add_task_message",
            description: "Adds a note or signal-specific message to a task without changing its board status.",
            input_schema: json!({"type":"object","properties":{"taskId":{"type":"string"},"message":{"type":"string"},"signal":{"type":"string","enum":["ready_for_review","needs_help","agent_working","note"]}},"required":["taskId","message"]}),
        },
        ToolDefinition {
            name: "move_task_to_abyss",
            description: "Soft-deletes a task so it leaves the board and can later be restored from the abyss.",
            input_schema: json!({"type":"object","properties":{"taskId":{"type":"string"}},"required":["taskId"]}),
        },
        ToolDefinition {
            name: "restore_task",
            description: "Restores a deleted or archived task back into active board visibility.",
            input_schema: json!({"type":"object","properties":{"taskId":{"type":"string"}},"required":["taskId"]}),
        },
        ToolDefinition {
            name: "add_plan_to_task",
            description: "Attaches an implementation plan to a task as markdown content.",
            input_schema: json!({"type":"object","properties":{"taskId":{"type":"string"},"content":{"type":"string"}},"required":["taskId","content"]}),
        },
        ToolDefinition {
            name: "create_tag",
            description: "Creates a new tag in the linked workspace project.",
            input_schema: json!({"type":"object","properties":{"name":{"type":"string"},"color":{"type":"string"}},"required":["name"],"additionalProperties":false}),
        },
        ToolDefinition {
            name: "delete_tag",
            description: "Deletes a project tag.",
            input_schema: json!({"type":"object","properties":{"tagId":{"type":"string"}},"required":["tagId"]}),
        },
        ToolDefinition {
            name: "export_tasks",
            description: "Builds an AI-ready export prompt from linked workspace project tasks using the same formatting options as the UI export modal.",
            input_schema: json!({
                "type":"object",
                "properties":{
                    "taskIds":{"type":"array","items":{"type":"string"}},
                    "format":{"type":"string","enum":["numbered","bullets","checkboxes","compact"]},
                    "includeTags":{"type":"boolean"},
                    "includePriority":{"type":"boolean"},
                    "includeDeleted":{"type":"boolean"},
                    "includeArchived":{"type":"boolean"},
                    "additionalInstructions":{
                        "type":"array",
                        "items":{
                            "type":"object",
                            "properties":{"title":{"type":"string"},"content":{"type":"string"}},
                            "required":["title","content"]
                        }
                    }
                },
                "required":[],
                "additionalProperties":false
            }),
        },
        ToolDefinition {
            name: "get_update_status",
            description: "Returns MCP release update status with installed/latest version, update availability, and recommended upgrade command.",
            input_schema: json!({"type":"object","properties":{}}),
        },
        ToolDefinition {
            name: "sync_global_instructions",
            description: "Triggers a background sync of the latest global agent instructions from the Pink Sundew server and writes them to local IDE instruction files (.cursor/rules/*.mdc, .windsurf/rules/*.md, CLAUDE.md, AGENTS.md, antigravity.md, .github/copilot-instructions.md, .github/instructions/*.instructions.md). Call this to refresh instructions mid-session without restarting the MCP server.",
            input_schema: json!({"type":"object","properties":{}}),
        },
    ]
}

fn project_scoped_tool_names() -> HashSet<&'static str> {
    HashSet::from([
        "get_project_board",
        "get_task_details",
        "list_abyss_tasks",
        "list_project_tags",
        "create_task",
        "update_task",
        "move_task",
        "set_task_signal",
        "list_task_messages",
        "add_task_message",
        "move_task_to_abyss",
        "restore_task",
        "add_plan_to_task",
        "create_tag",
        "delete_tag",
        "export_tasks",
    ])
}

fn is_tool_enabled(controls: &AgentControls, tool_name: &str) -> bool {
    controls
        .tool_toggles
        .get(tool_name)
        .copied()
        .unwrap_or(true)
}

fn required_str_arg<'a>(args: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    let object = as_object(args)?;
    object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("{} must be a string", key))
}

fn schema_object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn invalid_params_error(error: impl std::fmt::Display) -> McpError {
    McpError::invalid_params(error.to_string(), None)
}

fn internal_error(error: impl std::fmt::Display) -> McpError {
    McpError::internal_error(error.to_string(), None)
}
