// Échographies obstétricales d'une grossesse : médecins uniquement. Compte rendu et images
// sont déposés dans le bucket R2 (dossier echographie/) et servis par liens signés.
const Echographie = require('../models/Echographie');
const { auteurDe } = require('../models/commun');
const { journaliser } = require('../config/audit');
const stockage = require('../config/r2');
const { trouverGrossesse } = require('./patientes');

const DOSSIER_FICHIERS = 'echographie';
const erreur = (status, message) => Object.assign(new Error(message), { status });
const texte = (v, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));
const nombre = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const ouiNon = (v) => (v === true ? true : v === false ? false : null);
const objet = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const choix = (v, valeurs) => (valeurs.includes(v) ? v : '');

/** Champs acceptés (liste blanche, valeurs converties : jamais d'objet brut). */
function champs(d = {}) {
  const nombreFoetus = Math.min(Echographie.FOETUS_MAX, Math.max(1, Math.round(nombre(d.nombreFoetus) ?? 1)));
  const foetus = (Array.isArray(d.foetus) ? d.foetus : []).slice(0, nombreFoetus).map((f) => {
    const x = objet(f);
    return {
      activiteCardiaque: ouiNon(x.activiteCardiaque),
      sexe: choix(x.sexe, Echographie.SEXES),
      presentation: choix(x.presentation, Echographie.PRESENTATIONS),
      position: texte(x.position, 120),
      bipMm: nombre(x.bipMm), perimetreCranienMm: nombre(x.perimetreCranienMm),
      perimetreAbdominalMm: nombre(x.perimetreAbdominalMm), longueurFemoraleMm: nombre(x.longueurFemoraleMm),
      poidsEstimeG: nombre(x.poidsEstimeG),
    };
  });
  const placenta = objet(d.placenta);
  const liquide = objet(d.liquideAmniotique);
  const col = objet(d.col);
  return {
    date: texte(d.date, 10),
    motif: texte(d.motif, 300),
    agSemaines: nombre(d.agSemaines),
    agJours: nombre(d.agJours),
    nombreFoetus,
    foetus,
    placenta: { localisation: texte(placenta.localisation, 120), aspect: texte(placenta.aspect, 200), maturite: choix(placenta.maturite, Echographie.MATURITES_PLACENTA) },
    liquideAmniotique: { quantite: choix(liquide.quantite, Echographie.QUANTITES_LIQUIDE), indiceCm: nombre(liquide.indiceCm) },
    col: { longueurMm: nombre(col.longueurMm), aspect: texte(col.aspect, 200) },
    anomalies: texte(d.anomalies),
    conclusion: texte(d.conclusion),
    praticien: texte(d.praticien, 160),
  };
}

/** GET /api/grossesses/:id/echographies — de la plus récente à la plus ancienne. */
exports.lister = async (req, res) => {
  const g = await trouverGrossesse(req.params.id);
  const liste = await Echographie.find({ grossesseId: g._id }).sort({ date: -1, createdAt: -1 });
  res.json(await Promise.all(liste.map((e) => e.vue())));
};

/**
 * POST /api/grossesses/:id/echographies — multipart : « donnees » (JSON) et « fichiers »
 * (compte rendu PDF ou images, 6 au plus). Les fichiers sont retirés de R2 si l'enregistrement échoue.
 */
exports.creer = async (req, res) => {
  const g = await trouverGrossesse(req.params.id);
  let d;
  try {
    d = typeof req.body?.donnees === 'string' ? JSON.parse(req.body.donnees) : req.body || {};
  } catch {
    throw erreur(400, 'Données de l’échographie illisibles.');
  }
  const c = champs(d);
  if (!c.date) throw erreur(400, 'La date de l’examen est obligatoire.');
  if (c.date > new Date().toISOString().slice(0, 10)) throw erreur(400, 'La date de l’examen ne peut pas être dans le futur.');
  const echo = new Echographie({
    ...c,
    patienteId: g.patienteId,
    grossesseId: g._id,
    etablissementId: req.etablissementId ?? null,
    auteur: auteurDe(req.soignant),
  });
  await echo.validate().catch((err) => {
    throw erreur(400, Object.values(err.errors || {})[0]?.message || 'Données invalides.');
  });

  const envoyes = [];
  try {
    for (const f of req.files || []) {
      const { cle } = await stockage.envoyerFichier(f, DOSSIER_FICHIERS);
      envoyes.push({ cle, type: f.mimetype, nom: texte(f.originalname, 160) });
    }
    echo.fichiers = envoyes;
    await echo.save();
  } catch (err) {
    await Promise.all(envoyes.map((f) => stockage.supprimerFichier(f.cle).catch(() => {})));
    throw err;
  }
  await journaliser(req, {
    action: 'echographie.creation', patienteId: g.patienteId, ressource: { type: 'echographie', id: echo.id },
    details: { fichiers: envoyes.length },
  });
  res.status(201).json(await echo.vue());
};
