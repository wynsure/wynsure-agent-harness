/**
 * Common shape shared by every fragment: a `kind` discriminator plus a link to
 * the activity that produced it. When `activityId` is absent, the emitting
 * AgentContext fills it with the appropriate root (`modelActivityId` for LLM
 * generation, `harnessActivityId` for the rest). See docs/architecture.spec.md.
 *
 * `kind` (was `type`) is the variant discriminator — unified with the Cell
 * contract so an agent thread (`Leaf<Fragment>`) and a user-interaction
 * projection (`Leaf<InteractionItem>`) share one notion of "which variant is
 * this cell". The activity that triggered a child (e.g. an ActivityStart's
 * tool) is exposed as `tool`, not `kind`, to avoid the collision.
 */
import type { ActivityId, EnvironmentName, ToolUseId } from "./activity.ts"
import type { Cell } from "./leaf.ts"

export interface FragmentBase extends Cell {
   activityId?: ActivityId
}

export type FragmentKind =
   | "Instruction"
   | "PostureUse"
   | "PostureExit"
   | "SkillAttach"
   | "SkillDetach"
   | "UserMessage"
   | "AgentMessage"
   | "Thinking"
   | "ToolUse"
   | "ToolFeedback"
   | "Reference"
   | "SubagentSpawn"
   | "SubagentComplete"
   | "ActivityStart"
   | "ActivityProgress"
   | "ActivityComplete"
   | "Opaque"

export interface InstructionFragment extends FragmentBase {
   kind: "Instruction"
   content: string
   source?: string
}

export interface PostureUseFragment extends FragmentBase {
   kind: "PostureUse"
   name: string
   content: string
}

export interface PostureExitFragment extends FragmentBase {
   kind: "PostureExit"
   name: string
}

export interface SkillAttachFragment extends FragmentBase {
   kind: "SkillAttach"
   name: string
   content: string
}

export interface SkillDetachFragment extends FragmentBase {
   kind: "SkillDetach"
   name: string
}

export interface UserMessageFragment extends FragmentBase {
   kind: "UserMessage"
   content: string
}

export interface AgentMessageFragment extends FragmentBase {
   kind: "AgentMessage"
   content: string
}

export interface ThinkingFragment extends FragmentBase {
   kind: "Thinking"
   content: string
   source?: string
}

export interface ToolUseFragment extends FragmentBase {
   kind: "ToolUse"
   id: ToolUseId
   toolName: string
   arguments: Record<string, any>
}

export interface ToolFeedbackFragment extends FragmentBase {
   kind: "ToolFeedback"
   toolUseId: ToolUseId
   toolName: string
   result: any
   isError?: boolean
}

export interface ReferenceFragment extends FragmentBase {
   kind: "Reference"
   uri: string
   content: string
   mimeType?: string
}

export interface OpaqueFragment extends FragmentBase {
   kind: "Opaque"
   data: any
   label?: string
}

export interface SubagentSpawnFragment extends FragmentBase {
   kind: "SubagentSpawn"
   contextId: string
   agentId: string
   task: string
}

export interface SubagentCompleteFragment extends FragmentBase {
   kind: "SubagentComplete"
   contextId: string
   agentId: string
   status: "completed" | "terminated"
}

/**
 * Opens a child activity (child of one of the context's two activity roots:
 * `modelActivityId` for an LLM tool call, `harnessActivityId` for a hook /
 * guardrail). Ignored by the completion provider (audit signal). See
 * docs/architecture.spec.md.
 */
export interface ActivityStartFragment extends FragmentBase {
   kind: "ActivityStart"
   activityId: ActivityId
   parentActivityId: ActivityId
   environment: EnvironmentName
   /** Tool name that triggered the child (was `kind`, renamed to free `kind` for the discriminator). */
   tool: string
   arguments: Record<string, any>
   payload?: any
}

/**
 * Intermediate feedback from an in-flight delegated activity. Pushed by the
 * environment via the session to surface progress to the host in real time.
 * Ignored by the completion provider.
 */
export interface ActivityProgressFragment extends FragmentBase {
   kind: "ActivityProgress"
   activityId: ActivityId
   feedback: any
   progress?: number
}

/**
 * Terminal status of a delegated activity. Emitted by the context right before
 * the wrapping ToolFeedback that carries the final result. Ignored by the
 * completion provider.
 */
export interface ActivityCompleteFragment extends FragmentBase {
   kind: "ActivityComplete"
   activityId: ActivityId
   status: "completed" | "failed"
}

export type Fragment =
   | InstructionFragment
   | PostureUseFragment
   | PostureExitFragment
   | SkillAttachFragment
   | SkillDetachFragment
   | UserMessageFragment
   | AgentMessageFragment
   | ThinkingFragment
   | ToolUseFragment
   | ToolFeedbackFragment
   | ReferenceFragment
   | SubagentSpawnFragment
   | SubagentCompleteFragment
   | ActivityStartFragment
   | ActivityProgressFragment
   | ActivityCompleteFragment
   | OpaqueFragment

export type AnyFragment = Fragment

export type FragmentOfKind<T extends FragmentKind> = Extract<Fragment, { kind: T }>

export function createInstruction(content: string, source?: string): InstructionFragment {
   return { kind: "Instruction", content, source }
}

export function createPostureUse(name: string, content: string): PostureUseFragment {
   return { kind: "PostureUse", name, content }
}

export function createPostureExit(name: string): PostureExitFragment {
   return { kind: "PostureExit", name }
}

export function createSkillAttach(name: string, content: string): SkillAttachFragment {
   return { kind: "SkillAttach", name, content }
}

export function createSkillDetach(name: string): SkillDetachFragment {
   return { kind: "SkillDetach", name }
}

export function createUserMessage(content: string): UserMessageFragment {
   return { kind: "UserMessage", content }
}

export function createAgentMessage(content: string): AgentMessageFragment {
   return { kind: "AgentMessage", content }
}

export function createThinking(content: string, source?: string): ThinkingFragment {
   return { kind: "Thinking", content, source }
}

export function createToolUse(
   id: ToolUseId,
   toolName: string,
   args: Record<string, any>,
): ToolUseFragment {
   return { kind: "ToolUse", id, toolName, arguments: args }
}

export function createToolFeedback(
   toolUseId: ToolUseId,
   toolName: string,
   result: any,
   isError?: boolean,
): ToolFeedbackFragment {
   return { kind: "ToolFeedback", toolUseId, toolName, result, isError }
}

export function createReference(
   uri: string,
   content: string,
   mimeType?: string,
): ReferenceFragment {
   return { kind: "Reference", uri, content, mimeType }
}

export function createOpaque(data: any, label?: string): OpaqueFragment {
   return { kind: "Opaque", data: data, label }
}

export function createSubagentSpawn(
   contextId: string,
   agentId: string,
   task: string,
): SubagentSpawnFragment {
   return { kind: "SubagentSpawn", contextId, agentId, task }
}

export function createSubagentComplete(
   contextId: string,
   agentId: string,
   status: "completed" | "terminated",
): SubagentCompleteFragment {
   return { kind: "SubagentComplete", contextId, agentId, status }
}

export function createActivityStart(opts: {
   activityId: ActivityId
   parentActivityId: ActivityId
   environment: EnvironmentName
   tool: string
   arguments: Record<string, any>
   payload?: any
}): ActivityStartFragment {
   return {
      kind: "ActivityStart",
      activityId: opts.activityId,
      parentActivityId: opts.parentActivityId,
      environment: opts.environment,
      tool: opts.tool,
      arguments: opts.arguments,
      payload: opts.payload,
   }
}

export function createActivityProgress(
   activityId: ActivityId,
   feedback: any,
   progress?: number,
): ActivityProgressFragment {
   return { kind: "ActivityProgress", activityId, feedback, progress }
}

export function createActivityComplete(
   activityId: ActivityId,
   status: "completed" | "failed",
): ActivityCompleteFragment {
   return { kind: "ActivityComplete", activityId, status }
}
