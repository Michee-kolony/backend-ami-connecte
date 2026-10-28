// Conflits de synchronisation (mode hors connexion). Une MODIFICATION faite sur un appareil sans
// réseau porte la version du dossier que cet appareil avait sous les yeux (en-tête X-Version-Base :
// date de dernière modification). Si le dossier a été modifié depuis (autre appareil, autre soignant),
// la modification n'est pas appliquée : 409 « conflit », et la saisie reste sur l'appareil pour une
// décision humaine (appliquer quand même, ou abandonner). Rien n'est écrasé silencieusement.
// Les AJOUTS (consultation, surveillance, dose, rendez-vous…) ne sont jamais en conflit : les deux
// saisies sont conservées.

/** Tolérance d'horloge entre l'appareil et le serveur. */
const TOLERANCE_MS = 1000;

function verifierVersion(req, doc, libelle) {
  const base = req.get?.('X-Version-Base');
  if (!base || !doc?.updatedAt) return;
  const t = Date.parse(base);
  if (Number.isNaN(t) || doc.updatedAt.getTime() <= t + TOLERANCE_MS) return;
  const par = doc.modifiePar?.nom ?? null;
  const quand = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Kinshasa', dateStyle: 'short', timeStyle: 'short' }).format(doc.updatedAt);
  throw Object.assign(new Error(`Conflit : ${libelle} a été modifié${par ? ` par ${par}` : ''} le ${quand}, après la version présente sur cet appareil. Vérifiez le dossier, puis appliquez votre modification ou abandonnez-la.`), {
    status: 409,
    details: { conflit: true, modifieLe: doc.updatedAt, modifiePar: par },
  });
}

module.exports = { verifierVersion };
