import { availableDates, validateSchedule, normalizeServiceConfig, parseSlots, serializeDays } from '../server/src/service.js';
let pass = 0, fail = 0;
const ck = (l, ok, x='') => ok ? (pass++, console.log('  ok   '+l)) : (fail++, console.log('  FAIL '+l+' '+x));

const now = new Date('2026-11-02T09:00:00Z'); // Monday

// 24h prep, every day
let r = { service_type: 'preorder', min_prep_hours: 24, delivery_days: '', delivery_slots: '11:00-13:00,18:00-20:00', order_cutoff: '' };
let d = availableDates(r, now);
ck('24h -> commence demain', d[0] === '2026-11-03', d[0]);
ck('21 jours proposes', d.length === 21, String(d.length));

// 48h prep
r.min_prep_hours = 48;
d = availableDates(r, now);
ck('48h -> commence apres-demain', d[0] === '2026-11-04', d[0]);

// restricted days: Tue(2) and Fri(5) only
r.min_prep_hours = 24; r.delivery_days = '2,5';
d = availableDates(r, now);
ck('jours limites respectes', d.every((x) => [2,5].includes(new Date(x+'T00:00:00Z').getUTCDay())), d.slice(0,3).join(','));
ck('premier jour = mardi', d[0] === '2026-11-03', d[0]);

// cutoff passed -> pushes a day
r.delivery_days = ''; r.order_cutoff = '08:00';
d = availableDates(r, now);
ck('apres le cutoff -> +1 jour', d[0] === '2026-11-04', d[0]);
r.order_cutoff = '18:00';
d = availableDates(r, now);
ck('avant le cutoff -> inchange', d[0] === '2026-11-03', d[0]);

// validation
r = { service_type: 'preorder', min_prep_hours: 24, delivery_days: '', delivery_slots: '11:00-13:00', order_cutoff: '' };
ck('date+creneau valides', validateSchedule(r, '2026-11-03', '11:00-13:00', now).ok);
ck('sans date -> refuse', validateSchedule(r, '', '', now).reason === 'schedule_required');
ck('date trop tot -> refuse', validateSchedule(r, '2026-11-02', '11:00-13:00', now).reason === 'date_unavailable');
ck('creneau inconnu -> refuse', validateSchedule(r, '2026-11-03', '20:00-22:00', now).reason === 'slot_unavailable');

const imm = { service_type: 'immediate' };
ck('immediat sans planning -> ok', validateSchedule(imm, '', '', now).ok);
ck('immediat avec planning -> refuse', validateSchedule(imm, '2026-11-03', '11:00-13:00', now).reason === 'not_preorder');

// normalize
const cfg = normalizeServiceConfig({ service_type: 'preorder', min_prep_hours: 48, delivery_days: [5,2,2], delivery_slots: ['18:00-20:00','11:00-13:00'] });
ck('jours normalises et tries', cfg.delivery_days === '2,5', cfg.delivery_days);
ck('creneaux normalises', cfg.delivery_slots === '11:00-13:00,18:00-20:00', cfg.delivery_slots);
const immCfg = normalizeServiceConfig({ service_type: 'immediate', min_prep_hours: 48 });
ck('immediat efface la config', immCfg.min_prep_hours === 0 && immCfg.delivery_slots === '');
let threw = false;
try { normalizeServiceConfig({ service_type: 'preorder', min_prep_hours: 0, delivery_slots: ['11:00-13:00'] }); } catch { threw = true; }
ck('prep invalide -> erreur', threw);
threw = false;
try { normalizeServiceConfig({ service_type: 'preorder', min_prep_hours: 24, delivery_slots: [] }); } catch { threw = true; }
ck('sans creneau -> erreur', threw);

console.log(`\n  ${pass} verifications reussies, ${fail} echecs\n`);
process.exit(fail ? 1 : 0);
