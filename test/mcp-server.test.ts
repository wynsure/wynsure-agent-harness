/**
 * Smoke tests for the McpServer extension. Live HTTP connection to a remote
 * MCP server is out of scope for `npm test` — what we exercise here is the
 * surface that does not need network:
 *  - manifest schema validation (auth discriminated union, defaults)
 *  - the kind is registered under `agent/v1`
 *  - the `ClientCredentialsOAuthProvider` semantics (discovery short-circuit,
 *    `prepareTokenRequest` returns client_credentials, interactive hooks throw)
 *  - `toManifest()` preserves the raw `{{env.*}}` templates (no secret leak)
 *
 * Live HTTP + OAuth grant runs against a real server — covered by integration
 * tests, not by this unit suite.
 */
import { describe, it, assert, eq } from "./runner.ts"
import {
    McpServerObject,
    McpServerSpecSchema,
    McpServerManifestSchema,
    McpServerAuthSchema,
    ClientCredentialsOAuthProvider,
} from "../src/extensions/mcp-server/index.ts"
import { scheme, type ObjectLoadContext } from "../src/blueprint/object-meta.ts"
// Side-effect import to ensure the kind is registered.
import "../src/extensions"

describe("mcp-server schema", () => {
    it("endpoint is required", () => {
        const r = McpServerSpecSchema.safeParse({})
        assert(!r.success, "missing endpoint rejects")
    })

    it("auth defaults to { type: 'none' } when omitted", () => {
        const r = McpServerSpecSchema.parse({ endpoint: "https://mcp.example.com/mcp" })
        eq((r.auth as any).type, "none", "default auth is none")
    })

    it("auth: none parses", () => {
        const r = McpServerSpecSchema.safeParse({
            endpoint: "https://mcp.example.com/mcp",
            auth: { type: "none" },
        })
        assert(r.success, "none auth accepted")
    })

    it("auth: apiKey requires a non-empty token", () => {
        const ok = McpServerSpecSchema.safeParse({
            endpoint: "https://mcp.example.com/mcp",
            auth: { type: "apiKey", token: "abc" },
        })
        assert(ok.success, "apiKey with token accepted")
        const empty = McpServerSpecSchema.safeParse({
            endpoint: "https://mcp.example.com/mcp",
            auth: { type: "apiKey", token: "" },
        })
        assert(!empty.success, "empty token rejected")
    })

    it("auth: oauth requires clientId, clientSecret, tokenEndpoint", () => {
        const ok = McpServerSpecSchema.safeParse({
            endpoint: "https://mcp.example.com/mcp",
            auth: {
                type: "oauth",
                clientId: "id",
                clientSecret: "secret",
                tokenEndpoint: "https://auth.example.com/token",
            },
        })
        assert(ok.success, "oauth with full creds accepted")
        const missing = McpServerSpecSchema.safeParse({
            endpoint: "https://mcp.example.com/mcp",
            auth: { type: "oauth", clientId: "id" },
        })
        assert(!missing.success, "oauth missing clientSecret/tokenEndpoint rejected")
    })

    it("auth: oauth scope is optional", () => {
        const r = McpServerSpecSchema.parse({
            endpoint: "https://mcp.example.com/mcp",
            auth: {
                type: "oauth",
                clientId: "id",
                clientSecret: "secret",
                tokenEndpoint: "https://auth.example.com/token",
                scope: "tools.read",
            },
        })
        eq((r.auth as any).scope, "tools.read", "scope preserved")
    })

    it("auth: unknown discriminator rejected", () => {
        const r = McpServerSpecSchema.safeParse({
            endpoint: "https://mcp.example.com/mcp",
            auth: { type: "hmac" },
        })
        assert(!r.success, "unknown auth type rejected")
    })

    it("manifest envelope validates apiVersion + kind", () => {
        const r = McpServerManifestSchema.safeParse({
            apiVersion: "agent/v1",
            kind: "McpServer",
            metadata: { name: "crm" },
            spec: { endpoint: "https://mcp.example.com/mcp" },
        })
        assert(r.success, "valid manifest accepted")
    })

    it("auth sub-schema default is none (used by introspection surfaces)", () => {
        const r = McpServerAuthSchema.parse(undefined)
        eq((r as any).type, "none", "AuthSchema defaults to none")
    })
})

describe("mcp-server scheme registration", () => {
    it("McpServer is registered under agent/v1", () => {
        const entry = scheme.lookup("agent/v1", "McpServer")
        assert(!!entry, "registered")
        eq(entry!.metadata.surface, "Permanent (connexion persistante au load)", "surface documented")
    })

    it("McpServer factory is the static fromManifest", () => {
        const entry = scheme.lookup("agent/v1", "McpServer")!
        eq(entry.factory, McpServerObject.fromManifest, "factory wired to the class")
    })
})

describe("mcp-server oauth client_credentials provider", () => {
    const opts = {
        clientId: "id",
        clientSecret: "secret",
        tokenEndpoint: "https://auth.example.com/token",
        scope: "tools.read tools.write",
    }

    it("redirectUrl is undefined (non-interactive grant)", () => {
        const p = new ClientCredentialsOAuthProvider(opts)
        eq(p.redirectUrl, undefined, "no user-agent redirect")
    })

    it("clientMetadata declares client_credentials + client_secret_post", () => {
        const p = new ClientCredentialsOAuthProvider(opts)
        const meta: any = p.clientMetadata
        assert(meta.grant_types.includes("client_credentials"), "grant_types declares client_credentials")
        eq(meta.token_endpoint_auth_method, "client_secret_post", "auth method pinned")
        eq(meta.scope, opts.scope, "scope advertised")
    })

    it("clientInformation exposes the credentials", () => {
        const p = new ClientCredentialsOAuthProvider(opts)
        const info: any = p.clientInformation()
        eq(info.client_id, "id", "client_id")
        eq(info.client_secret, "secret", "client_secret")
    })

    it("prepareTokenRequest returns grant_type=client_credentials + scope", () => {
        const p = new ClientCredentialsOAuthProvider(opts)
        const params = p.prepareTokenRequest()
        eq(params.get("grant_type"), "client_credentials", "grant_type")
        eq(params.get("scope"), opts.scope, "scope from opts")
    })

    it("prepareTokenRequest(scope?) lets the SDK override the scope", () => {
        const p = new ClientCredentialsOAuthProvider(opts)
        const params = p.prepareTokenRequest("downscoped")
        eq(params.get("scope"), "downscoped", "scope overridden by caller")
    })

    it("prepareTokenRequest without scope omits the param entirely", () => {
        const p = new ClientCredentialsOAuthProvider({ ...opts, scope: undefined })
        const params = p.prepareTokenRequest()
        eq(params.has("scope"), false, "scope absent when none configured")
    })

    it("discoveryState pins the token endpoint (no RFC 9728 discovery)", () => {
        const p = new ClientCredentialsOAuthProvider(opts)
        const state: any = p.discoveryState()
        eq(state.authorizationServerUrl, opts.tokenEndpoint, "auth server url pinned")
        eq(state.authorizationServerMetadata.token_endpoint, opts.tokenEndpoint, "token_endpoint pinned")
    })

    it("saveDiscoveryState is a no-op (state is spec-derived)", () => {
        const p = new ClientCredentialsOAuthProvider(opts)
        // Just assert it does not throw — the state is constant.
        p.saveDiscoveryState({} as any)
        const after: any = p.discoveryState()
        eq(after.authorizationServerUrl, opts.tokenEndpoint, "state unchanged after save")
    })

    it("interactive hooks (redirectToAuthorization, PKCE) throw on accidental call", () => {
        const p = new ClientCredentialsOAuthProvider(opts)
        let threw = false
        try { p.redirectToAuthorization(new URL("https://example.com")) } catch { threw = true }
        assert(threw, "redirectToAuthorization refuses")
        threw = false
        try { p.saveCodeVerifier("x") } catch { threw = true }
        assert(threw, "saveCodeVerifier refuses")
        threw = false
        try { p.codeVerifier() } catch { threw = true }
        assert(threw, "codeVerifier refuses")
    })

    it("tokens() starts undefined, saveTokens stores, invalidateCredentials clears", () => {
        const p = new ClientCredentialsOAuthProvider(opts)
        eq(p.tokens(), undefined, "no token at construction")
        p.saveTokens({ access_token: "AT", token_type: "Bearer" } as any)
        eq(p.tokens()?.access_token, "AT", "token stored")
        p.invalidateCredentials("tokens")
        eq(p.tokens(), undefined, "tokens scope clears the stored token")
    })
})

describe("mcp-server template preservation in toManifest", () => {
    it("toManifest keeps raw {{env.*}} templates (no resolved secret leak)", () => {
        // Construct the object directly with a templated spec — no live
        // connection is triggered (constructor is pure).
        const obj = new McpServerObject(
            { name: "crm" },
            {
                endpoint: "https://mcp.example.com/mcp",
                auth: { type: "apiKey", token: "{{env.CRM_API_KEY}}" },
            } as any,
        )
        const manifest: any = obj.toManifest()
        eq(manifest.spec.auth.token, "{{env.CRM_API_KEY}}", "template preserved verbatim in spec")
    })

    it("factory refuses to connect to a non-MCP endpoint at load (fail-fast)", async () => {
        // Pointing at a closed port surfaces the failure at load time rather
        // than on the first tool call. We expect the factory to throw.
        const manifest = {
            apiVersion: "agent/v1",
            kind: "McpServer",
            metadata: { name: "dead" },
            spec: { endpoint: "http://127.0.0.1:1/mcp" },
        } as any
        const ctx: ObjectLoadContext = { cwd: ".", blueprint: undefined }
        let threw = false
        try {
            const entry = scheme.lookup("agent/v1", "McpServer")!
            await entry.factory(manifest, ctx)
        } catch {
            threw = true
        }
        assert(threw, "factory fails fast when no transport can connect")
    })
})
