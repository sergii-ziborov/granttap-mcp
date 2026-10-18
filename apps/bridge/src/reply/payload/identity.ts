import { createHash } from 'node:crypto';
import type { UserAttachment } from '../../../../../packages/protocol/schema';
import type { DeliveryOptions } from './types';

/** Restaging an attachment changes its local path, not the controller's intent. */
export function deliveryIntent(text: string, attachments: UserAttachment[], options: DeliveryOptions): string {
  return createHash('sha256').update(JSON.stringify({ text,
    attachments: attachments.map(file => ({ name: file.name, mimeType: file.mimeType,
      digest: createHash('sha256').update(Buffer.from(file.data, 'base64')).digest('hex') })),
    model: options.model, effort: options.effort, preferredMcp: options.preferredMcp,
    skill: options.skill, permissionMode: options.permissionMode,
  })).digest('hex');
}
