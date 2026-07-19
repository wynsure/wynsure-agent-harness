/**
 * The apiVersion (group/version) shared by every kind in the v1 contract.
 * Declared in its own module so foundational pieces (builtin presets, schema
 * definitions) can reference it without importing a concrete resource module
 * and creating an import cycle.
 */
export const AGENT_API_VERSION = "agent/v1"
