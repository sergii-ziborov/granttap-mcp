/** Public entry of the phones paired with this computer: listing, removal, and the place a new phone takes. */
export { DAY_MS, EXTRA_PHONE_LIMIT, idleFor, lastActivity, longestIdle, mostRecentPhone, phoneEntries, phoneId,
  phoneRoster, stalePhones, type PhoneRecord } from "./roster";
export { LAST_PHONE, PhoneChangeRefused, removePhoneKeys, type PhoneRemoval } from "./removal";
export { admitPhoneKey, EVICTION_IDLE_HOURS, evictionFor, PHONE_LIMIT_REACHED, PhoneLimitReached } from "./admission";
export { isPhoneAction, phonesFor, planPhoneChange, type PhoneChangeOutcome, type PlannedPhoneChange }
  from "./device-actions";
