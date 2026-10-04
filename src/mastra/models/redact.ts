const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

export function redactSecrets(text: string): string {
  let result = text.replace(SECRET_PATTERNS[0], 'sk-***');
  result = result.replace(SECRET_PATTERNS[1], '$1***');
  return result.replace(SECRET_PATTERNS[2], '***');
}
