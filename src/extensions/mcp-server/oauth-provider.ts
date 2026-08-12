import type {
    OAuthClientProvider,
    OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js"
import type {
    OAuthClientMetadata,
    OAuthClientInformationMixed,
    OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"

/**
 * `ClientCredentialsOAuthProvider` — non-interactive OAuth 2.0 `client_credentials`
 * provider for an `McpServer` resource. Server-to-server: no end-user, no redirect,
 * no PKCE. The blueprint supplies the credentials and the token endpoint; the
 * provider hands them to the MCP SDK's `auth()` orchestrator, which POSTs the
 * grant and stores the resulting access token.
 *
 * Discovery is short-circuited: rather than probing `/.well-known/...` on the
 * MCP server, the provider pre-populates an `OAuthDiscoveryState` whose
 * `token_endpoint` is the one declared in the spec. Without this, the SDK
 * would either fall back to posting to the MCP server URL (wrong endpoint) or
 * fail when the server does not implement RFC 9728.
 *
 * All values passed here are already template-resolved by the McpServer
 * factory (the spec's `{{env.MY_VAR}}` placeholders are rendered against
 * `process.env` at connection time, never inside this provider).
 *
 * v1 limitation: the access token is held in memory for the lifetime of the
 * resource object. The SDK refreshes it through the same grant when the
 * transport reports `UnauthorizedError`; there is no cross-session persistence.
 */
export interface ClientCredentialsOptions {
    /** Template-resolved client identifier. */
    readonly clientId: string
    /** Template-resolved client secret. */
    readonly clientSecret: string
    /** Template-resolved token endpoint URL. */
    readonly tokenEndpoint: string
    /** Optional scope string sent with the grant. */
    readonly scope?: string
}

export class ClientCredentialsOAuthProvider implements OAuthClientProvider {
    private tokensValue: OAuthTokens | undefined
    private readonly opts: ClientCredentialsOptions

    constructor(opts: ClientCredentialsOptions) {
        this.opts = opts
    }

    /** Non-interactive flow: no user-agent redirect. */
    get redirectUrl(): undefined {
        return undefined
    }

    get clientMetadata(): OAuthClientMetadata {
        return {
            redirect_uris: [],
            grant_types: ["client_credentials"],
            // client_secret_post keeps credentials in the form body — broadly
            // supported and avoids an Authorization header competing with the
            // bearer token on the MCP request itself.
            token_endpoint_auth_method: "client_secret_post",
            ...(this.opts.scope ? { scope: this.opts.scope } : {}),
        }
    }

    clientInformation(): OAuthClientInformationMixed {
        return {
            client_id: this.opts.clientId,
            client_secret: this.opts.clientSecret,
            token_endpoint_auth_method: "client_secret_post",
        }
    }

    tokens(): OAuthTokens | undefined {
        return this.tokensValue
    }

    saveTokens(tokens: OAuthTokens): void {
        this.tokensValue = tokens
    }

    /**
     * Returns a static discovery state that pins the token endpoint to the
     * value declared in the spec. The SDK consumes this instead of running
     * RFC 9728 / RFC 8414 discovery.
     */
    discoveryState(): OAuthDiscoveryState | undefined {
        return {
            authorizationServerUrl: this.opts.tokenEndpoint,
            authorizationServerMetadata: {
                issuer: this.opts.tokenEndpoint,
                token_endpoint: this.opts.tokenEndpoint,
                // Unused by the client_credentials flow, but required by the
                // AuthorizationServerMetadata schema.
                authorization_endpoint: this.opts.tokenEndpoint,
                response_types_supported: [],
            },
        }
    }

    saveDiscoveryState(): void {
        // No-op: the discovery state is fully derived from the spec.
    }

    /**
     * Drives `fetchToken` toward a `client_credentials` grant. Returning
     * params with `grant_type=client_credentials` is what makes the SDK skip
     * the authorization_code path entirely.
     */
    prepareTokenRequest(scope?: string): URLSearchParams {
        const params = new URLSearchParams({ grant_type: "client_credentials" })
        const resolved = scope ?? this.opts.scope
        if (resolved) params.set("scope", resolved)
        return params
    }

    invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
        if (scope === "all" || scope === "tokens") {
            this.tokensValue = undefined
        }
    }

    // The following hooks belong to the interactive authorization_code flow
    // and are unreachable for client_credentials. They throw to surface any
    // accidental invocation rather than silently no-op'ing.

    redirectToAuthorization(): never {
        throw new Error(
            "McpServer OAuth (client_credentials): redirectToAuthorization is not reachable; " +
                "the grant is non-interactive. If you see this, the server rejected the client credentials.",
        )
    }

    saveCodeVerifier(): never {
        throw new Error("McpServer OAuth (client_credentials): PKCE does not apply to this grant.")
    }

    codeVerifier(): never {
        throw new Error("McpServer OAuth (client_credentials): PKCE does not apply to this grant.")
    }
}
