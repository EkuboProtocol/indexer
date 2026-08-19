export class StarknetRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "StarknetRpcError";
  }
}

export class UnsupportedStarknetRpcVersionError extends Error {
  /**
   * Use this error only after establishing that the endpoint is incompatible.
   * A specification version alone must not be treated as a closed allowlist.
   */
  constructor(readonly specVersion: string) {
    super(
      `Starknet RPC specification ${specVersion} is not compatible with this package.`,
    );
    this.name = "UnsupportedStarknetRpcVersionError";
  }
}

export class StarknetRpcCapabilityError extends Error {
  constructor(
    readonly capability: string,
    detail?: string,
  ) {
    super(
      `Starknet RPC capability '${capability}' is required` +
        (detail ? `: ${detail}` : "."),
    );
    this.name = "StarknetRpcCapabilityError";
  }
}
