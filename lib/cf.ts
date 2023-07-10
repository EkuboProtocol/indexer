export class CloudflareKV {
  private accountId: string;
  private namespaceId: string;
  private apiToken: string;

  public constructor({
    accountId,
    namespaceId,
    apiToken,
  }: {
    accountId: string;
    namespaceId: string;
    apiToken: string;
  }) {
    this.accountId = accountId;
    this.namespaceId = namespaceId;
    this.apiToken = apiToken;
  }

  async write(key: string, value: string): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}/values/${key}`;

    const response = await fetch(url, {
      method: "PUT",
      body: value,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Failed to write to KV store: ${message}`);
    }
  }

  async delete(key: string): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}/values/${key}`;

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Failed to write to KV store: ${message}`);
    }
  }
}
