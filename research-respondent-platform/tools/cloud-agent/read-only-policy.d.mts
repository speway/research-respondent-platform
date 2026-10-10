export function isReadOnlyFormUrl(raw: string): boolean;
export function readOnlyRequestAllowed(request: { url: string; method: string; navigation: boolean; postData?: string }): boolean;
