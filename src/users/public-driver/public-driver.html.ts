import { ASSET_PRODUCTS } from '../../asset-credit/asset-credit-products';
import { publicPhotoUrl, type PublicDriverCard } from './public-driver.model';

export const PUBLIC_DRIVER_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src https:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
export const escapeHtml = (value: unknown) =>
  (typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : ''
  ).replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
const category = {
  private: 'Conducteur privé',
  transport: 'Taxi / moto-taxi',
  intercity: 'Conducteur interurbain',
};

const css = `*{box-sizing:border-box}body{margin:0;background:#f8f9fa;color:#212529;font:16px/1.5 system-ui,sans-serif}
main{max-width:600px;margin:auto;padding:24px 20px 40px}header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{font-size:24px;font-weight:800;color:#c94200}small,.muted{color:#6c757d}.identity{text-align:center;padding:28px 0 18px}
.avatar{width:96px;height:96px;border-radius:50%;object-fit:cover;display:inline-flex;align-items:center;justify-content:center;background:#fff0e8;color:#c94200;font-size:36px;font-weight:700}
h1{font-size:28px;line-height:1.2;margin:12px 0 6px;overflow-wrap:anywhere}h2{font-size:19px;margin:0 0 12px}p{margin:6px 0}
.stats{display:flex;justify-content:center;gap:24px;text-align:center;padding:16px 0 22px}.stats strong{display:block;font-size:21px}
section{border-top:1px solid #dee2e6;padding:22px 0}ul{padding:0;margin:0;list-style:none}li{padding:12px 0;overflow-wrap:anywhere}li+li{border-top:1px solid #e9ecef}
.row{display:flex;align-items:center;justify-content:space-between;gap:16px}.badge{white-space:nowrap;font-size:14px;background:#fff0e8;color:#a33c09;border-radius:20px;padding:4px 12px}.paid{background:#e8f5ef;color:#166342}
footer{border-top:1px solid #dee2e6;padding-top:18px;font-size:13px;color:#6c757d}a{color:#a33c09}a:focus-visible{outline:3px solid #212529}
@media(max-width:360px){main{padding:18px 16px}.stats{gap:16px}h1{font-size:24px}}`;

export function renderDriverCard(card?: PublicDriverCard): string {
  const e = escapeHtml;
  const photo = publicPhotoUrl(card?.profilePicture ?? null);
  const content = !card
    ? `<section><h1>Fiche indisponible</h1><p>Ce conducteur n’est pas disponible ou la connexion a échoué. Réessayez plus tard.</p></section>`
    : `
    <div class="identity">${photo ? `<img class="avatar" src="${e(photo)}" alt="Photo du conducteur" referrerpolicy="no-referrer">` : `<div class="avatar" aria-hidden="true">${e(card.firstName.charAt(0))}</div>`}
      <h1>${e(card.firstName)} ${e(card.lastName)}</h1><p>${e(card.driverCategory ? category[card.driverCategory] : 'Conducteur Zwanga')}</p>
      ${card.isPhoneVerified ? '<small>Numéro de téléphone vérifié</small>' : ''}
    </div>
    <div class="stats"><div><strong>${card.averageRating === null ? '—' : e(card.averageRating)} / 5</strong><small>${e(card.totalRatings)} avis</small></div>
      <div><strong>${e(card.completedTrips)}</strong><small>trajets terminés</small></div></div>
    <section><h2>Véhicules</h2>${card.vehicles.length ? `<ul>${card.vehicles.map((v) => `<li><strong>${e(v.brand)} ${e(v.model)}</strong><p class="muted">${e(v.color)} · ${e(v.licensePlate)}</p></li>`).join('')}</ul>` : '<p class="muted">Aucun véhicule public actuellement.</p>'}</section>
    <section><h2>Biens à crédit chez Zwanga</h2>${card.credits.length ? `<ul>${card.credits.map((c) => `<li class="row"><span>${e(ASSET_PRODUCTS.find((p) => p.kind === c.assetKind)?.label ?? 'Équipement')}</span><span class="badge ${c.status === 'settled' ? 'paid' : ''}">${c.status === 'settled' ? 'Soldé' : 'En cours'}</span></li>`).join('')}</ul>` : '<p class="muted">Aucun bien à crédit activé ou soldé chez Zwanga.</p>'}
      <p class="muted"><small>Seuls le type de bien et son statut sont publics.</small></p></section>`;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Fiche conducteur · Zwanga</title><style>${css}</style></head><body><main><header><span class="brand">Zwanga</span><small>Fiche publique</small></header>${content}<footer>Informations consultées à l’ouverture de cette page. Ce QR identifie un profil, pas la personne qui le présente. Comparez la photo et le véhicule avant votre trajet.</footer></main></body></html>`;
}
