/** Only complete host envelopes are metadata. Quoted or unknown XML stays visible. */
export function heartbeatDisplayText(value: unknown, kind: string): string | undefined {
  if (typeof value !== 'string' || !['user', 'message', 'final'].includes(kind)) return undefined;
  const root = /^<heartbeat>([\s\S]*)<\/heartbeat>$/.exec(value.trim());
  if (!root) return undefined;
  const body = root[1]!;
  const fields = new Map<string, string>();
  let offset = 0;
  for (const match of body.matchAll(/<([a-z_]+)>([^<]*)<\/\1>/g)) {
    if (body.slice(offset, match.index).trim() || fields.has(match[1]!)) return undefined;
    const decoded = xmlText(match[2]!);
    if (decoded === undefined) return undefined;
    fields.set(match[1]!, decoded.trim());
    offset = match.index + match[0].length;
  }
  if (body.slice(offset).trim() || !fields.get('automation_id')) return undefined;
  if (kind === 'user') {
    if ([...fields.keys()].some(key => !['automation_id', 'current_time_iso', 'instructions'].includes(key))
      || !fields.get('instructions') || fields.get('current_time_iso') === '') return undefined;
    return '';
  }
  if (fields.size !== 3 || !fields.has('decision') || !fields.get('message')) return undefined;
  if (fields.get('decision') === 'DONT_NOTIFY') return '';
  return fields.get('decision') === 'NOTIFY' ? fields.get('message') : undefined;
}

function xmlText(value: string): string | undefined {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  if ([...value].some(character => !xmlCharacter(character.codePointAt(0)!))) return undefined;
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(value)) return undefined;
  let valid = true;
  const decoded = value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_all, entity: string) => {
    if (entities[entity] !== undefined) return entities[entity];
    const number = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (xmlCharacter(number)) {
      return String.fromCodePoint(number);
    }
    valid = false;
    return '';
  });
  return valid ? decoded : undefined;
}

function xmlCharacter(number: number): boolean {
  return number === 9 || number === 10 || number === 13 || number >= 0x20 && number <= 0xd7ff
    || number >= 0xe000 && number <= 0xfffd || number >= 0x10000 && number <= 0x10ffff;
}
