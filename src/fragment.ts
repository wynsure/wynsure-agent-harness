/**
 * Common shape shared by every fragment: a link to the activity that produced
 * it. When absent, the emitting AgentContext fills it with the appropriate
 * root (`modelActivityId` for LLM generation, `harnessActivityId` for the
 * rest). See docs/activities.spec.md, docs/hooks-guardrails.spec.md.
 */
export interface FragmentBase {
   activityId?: string
}

export type FragmentType =
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
   type: "Instruction"
   content: string
   source?: string
}

export interface PostureUseFragment extends FragmentBase {
   type: "PostureUse"
   name: string
   content: string
}

export interface PostureExitFragment extends FragmentBase {
   type: "PostureExit"
   name: string
}

export interface SkillAttachFragment extends FragmentBase {
   type: "SkillAttach"
   name: string
   content: string
}

export interface SkillDetachFragment extends FragmentBase {
   type: "SkillDetach"
   name: string
}

export interface UserMessageFragment extends FragmentBase {
   type: "UserMessage"
   content: string
}

export interface AgentMessageFragment extends FragmentBase {
   type: "AgentMessage"
   content: string
}

export interface ThinkingFragment extends FragmentBase {
   type: "Thinking"
   content: string
   source?: string
}

export interface ToolUseFragment extends FragmentBase {
   type: "ToolUse"
   id: string
   toolName: string
   arguments: Record<string, any>
}

export interface ToolFeedbackFragment extends FragmentBase {
   type: "ToolFeedback"
   toolUseId: string
   toolName: string
   result: any
   isError?: boolean
}

export interface ReferenceFragment extends FragmentBase {
   type: "Reference"
   uri: string
   content: string
   mimeType?: string
}

export interface OpaqueFragment extends FragmentBase {
   type: "Opaque"
   data: any
   label?: string
}

export interface SubagentSpawnFragment extends FragmentBase {
   type: "SubagentSpawn"
   contextId: string
   agentId: string
   task: string
}

export interface SubagentCompleteFragment extends FragmentBase {
   type: "SubagentComplete"
   contextId: string
   agentId: string
   status: "completed" | "terminated"
}

/**
 * Opens a delegated activity (child of one of the context's two activity
 * roots: `modelActivityId` for an LLM tool call, `harnessActivityId` for a
 * hook / guardrail). Associates the triggering ToolUse with
 * the new activity. Ignored by the completion provider (audit signal). See
 * docs/activities.spec.md.
 */
export interface ActivityStartFragment extends FragmentBase {
   type: "ActivityStart"
   activityId: string
   parentActivityId: string
   environment: string
   toolUseId?: string
   kind: string
   arguments: Record<string, any>
   payload?: any
}

/**
 * Intermediate feedback from an in-flight delegated activity. Pushed by the
 * environment via the session to surface progress to the host in real time.
 * Ignored by the completion provider.
 */
export interface ActivityProgressFragment extends FragmentBase {
   type: "ActivityProgress"
   activityId: string
   feedback: any
   progress?: number
}

/**
 * Terminal status of a delegated activity. Emitted by the context right before
 * the wrapping ToolFeedback that carries the final result. Ignored by the
 * completion provider.
 */
export interface ActivityCompleteFragment extends FragmentBase {
   type: "ActivityComplete"
   activityId: string
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

export type FragmentOfType<T extends FragmentType> = Extract<Fragment, { type: T }>

export function createInstruction(content: string, source?: string): InstructionFragment {
   return { type: "Instruction", content, source }
}

export function createPostureUse(name: string, content: string): PostureUseFragment {
   return { type: "PostureUse", name, content }
}

export function createPostureExit(name: string): PostureExitFragment {
   return { type: "PostureExit", name }
}

export function createSkillAttach(name: string, content: string): SkillAttachFragment {
   return { type: "SkillAttach", name, content }
}

export function createSkillDetach(name: string): SkillDetachFragment {
   return { type: "SkillDetach", name }
}

export function createUserMessage(content: string): UserMessageFragment {
   return { type: "UserMessage", content }
}

export function createAgentMessage(content: string): AgentMessageFragment {
   return { type: "AgentMessage", content }
}

export function createThinking(content: string, source?: string): ThinkingFragment {
   return { type: "Thinking", content, source }
}

export function createToolUse(
   id: string,
   toolName: string,
   args: Record<string, any>,
): ToolUseFragment {
   return { type: "ToolUse", id, toolName, arguments: args }
}

export function createToolFeedback(
   toolUseId: string,
   toolName: string,
   result: any,
   isError?: boolean,
): ToolFeedbackFragment {
   return { type: "ToolFeedback", toolUseId, toolName, result, isError }
}

export function createReference(
   uri: string,
   content: string,
   mimeType?: string,
): ReferenceFragment {
   return { type: "Reference", uri, content, mimeType }
}

export function createOpaque(data: any, label?: string): OpaqueFragment {
   return { type: "Opaque", data: data, label }
}

export function createSubagentSpawn(
   contextId: string,
   agentId: string,
   task: string,
): SubagentSpawnFragment {
   return { type: "SubagentSpawn", contextId, agentId, task }
}

export function createSubagentComplete(
   contextId: string,
   agentId: string,
   status: "completed" | "terminated",
): SubagentCompleteFragment {
   return { type: "SubagentComplete", contextId, agentId, status }
}

export function createActivityStart(opts: {
   activityId: string
   parentActivityId: string
   environment: string
   kind: string
   arguments: Record<string, any>
   toolUseId?: string
   payload?: any
}): ActivityStartFragment {
   return {
      type: "ActivityStart",
      activityId: opts.activityId,
      parentActivityId: opts.parentActivityId,
      environment: opts.environment,
      kind: opts.kind,
      arguments: opts.arguments,
      toolUseId: opts.toolUseId,
      payload: opts.payload,
   }
}

export function createActivityProgress(
   activityId: string,
   feedback: any,
   progress?: number,
): ActivityProgressFragment {
   return { type: "ActivityProgress", activityId, feedback, progress }
}

export function createActivityComplete(
   activityId: string,
   status: "completed" | "failed",
): ActivityCompleteFragment {
   return { type: "ActivityComplete", activityId, status }
}
