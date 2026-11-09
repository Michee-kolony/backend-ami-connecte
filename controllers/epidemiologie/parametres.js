// Sous-fenêtre 2 — Paramètres et coefficients démographiques (administrables, documentés,
// versionnés et validés : jamais inscrits dans le code), et catalogue central des indicateurs de
// couverture (fiches techniques versionnées, sous-fenêtre 7).
const mongoose = require('mongoose');
const CoefficientDemographique = require('../../models/CoefficientDemographique');
const IndicateurEpi = require('../../models/IndicateurEpi');
const EntiteGeographique = require('../../models/EntiteGeographique');
const { numeroSuivant } = require('../../models/validationEpi');
const epi = require('../../config/epidemiologie');
const { erreur, texte, objet, jour } = require('../saisie');
const c = require('./commun');
const { initialiser } = require('./referentiel');

const messageValidation = (e) => require('../../config/erreursFr').messageValidation(e);

function lireCoefficient(d, partiel = false) {
  const o = {};
  const present = (k) => d[k] !== undefined;
  if (!partiel || present('nom')) { o.nom = texte(d.nom, 120); if (!o.nom) throw erreur(400, 'Nom du paramètre obligatoire.'); }
  if (!partiel || present('cible')) { if (!epi.CIBLES[d.cible]) throw erreur(400, 'Population cible invalide.'); o.cible = d.cible; }
  if (present('populationReference')) o.populationReference = texte(d.populationReference, 120) || 'Population totale';
  if (!partiel || present('valeurPct')) {
    const v = Number(String(d.valeurPct ?? '').replace(',', '.'));
    if (d.valeurPct === '' || d.valeurPct == null || !Number.isFinite(v) || v < 0 || v > 100) throw erreur(400, 'Coefficient : pourcentage entre 0 et 100 attendu.');
    o.valeurPct = v;
  }
  if (present('programme')) { if (!epi.PROGRAMMES.includes(d.programme)) throw erreur(400, 'Programme invalide.'); o.programme = d.programme; }
  if (!partiel || present('dateDebut')) { o.dateDebut = jour(d.dateDebut, 'Date de début'); if (!o.dateDebut) throw erreur(400, 'Date de début d’application obligatoire.'); }
  if (present('dateFin')) o.dateFin = jour(d.dateFin, 'Date de fin');
  if (o.dateFin && o.dateDebut && o.dateFin < o.dateDebut) throw erreur(400, 'La date de fin précède la date de début.');
  if (present('source')) o.source = texte(d.source, 500);
  if (present('commentaire')) o.commentaire = texte(d.commentaire, 2000);
  return o;
}

async function trouver(Modele, id, libelle) {
  if (!mongoose.isValidObjectId(id)) throw erreur(404, `${libelle} introuvable.`);
  const d = await Modele.findById(id);
  if (!d) throw erreur(404, `${libelle} introuvable.`);
  return d;
}

exports.listerCoefficients = async (req, res) => {
  await initialiser();
  const filtre = req.query.archives === 'oui' ? {} : { statut: { $ne: 'Archivé' } };
  if (req.query.code) filtre.code = texte(req.query.code, 20).toUpperCase();
  const liste = await CoefficientDemographique.find(filtre).sort({ code: 1, version: -1 });
  const entites = new Map((await EntiteGeographique.find({ code: { $in: liste.map((x) => x.entiteCode) } }).lean()).map((e) => [e.code, e]));
  // Historique de toutes les versions (graphique « évolution des coefficients »).
  const toutes = await CoefficientDemographique.find().sort({ code: 1, version: 1 }).select('code nom version valeurPct statut dateDebut dateFin entiteCode').lean();
  res.json({
    coefficients: liste.map((x) => ({ ...x.toJSON(), territoire: entites.get(x.entiteCode)?.nom ?? x.entiteCode })),
    versions: toutes.map((v) => ({ code: v.code, nom: v.nom, version: v.version, valeurPct: v.valeurPct, statut: v.statut, dateDebut: v.dateDebut, dateFin: v.dateFin, entiteCode: v.entiteCode })),
    modifiable: c.aRole(req, epi.ROLES_PLANIFICATION),
  });
};

/** Proposition d'un coefficient (épidémiologiste, responsable) : brouillon à soumettre et valider. */
exports.creerCoefficient = async (req, res) => {
  await c.exigerPlanification(req);
  await initialiser();
  const d = objet(req.body);
  const e = await c.entite(d.entiteCode || 'CD');
  const code = texte(d.code, 20).toUpperCase() || (await numeroSuivant(CoefficientDemographique, 'DEM', 'code')).replace(/-0+(\d{3,})$/, '-$1');
  if (await CoefficientDemographique.exists({ code })) throw erreur(409, `Le code ${code} existe déjà : modifiez ce paramètre pour en créer une nouvelle version.`);
  const coef = new CoefficientDemographique({ ...lireCoefficient(d), code, entiteCode: e.code, creePar: c.auteur(req) });
  coef.tracer('Création', c.auteur(req));
  await coef.validate().catch((err) => { throw erreur(400, messageValidation(err)); });
  await coef.save();
  await c.tracer(req, 'epi.coefficient', { type: 'coefficient', id: coef.id }, { operation: 'création', code });
  res.status(201).json(coef);
};

/** Modification : un coefficient validé n'est jamais modifié directement (nouvelle version). */
exports.modifierCoefficient = async (req, res) => {
  await c.exigerPlanification(req);
  const coef = await trouver(CoefficientDemographique, req.params.id, 'Coefficient');
  const d = objet(req.body);
  const champs = lireCoefficient(d, true);
  if (d.entiteCode !== undefined) champs.entiteCode = (await c.entite(d.entiteCode)).code;
  const r = await c.modifier(req, 'coefficient', coef, (doc) => Object.assign(doc, champs), d.motif);
  await c.tracer(req, 'epi.coefficient', { type: 'coefficient', id: r.id }, { operation: 'modification', code: r.code, version: r.version });
  res.json(r);
};

/**
 * Coefficients validés applicables à une entité et une année : pour chaque population cible, le
 * coefficient du territoire le plus précis (entité, puis ses ancêtres jusqu'au national) dont la
 * période couvre l'année, de préférence celui en vigueur au 1er juillet (milieu d'année).
 */
async function coefficientsApplicables(entiteCode, annee) {
  const e = await EntiteGeographique.findOne({ code: entiteCode }).lean();
  const chemin = e?.chemin ?? ['CD'];
  const du = `${annee}-01-01`;
  const au = `${annee}-12-31`;
  const milieu = `${annee}-07-01`;
  const candidats = await CoefficientDemographique.find({
    statut: 'Validé', entiteCode: { $in: chemin }, dateDebut: { $lte: au }, $or: [{ dateFin: null }, { dateFin: { $gte: du } }],
  });
  const resultat = {};
  for (const cible of Object.keys(epi.CIBLES)) {
    const liste = candidats.filter((x) => x.cible === cible).sort((a, b) => {
      const prof = chemin.indexOf(b.entiteCode) - chemin.indexOf(a.entiteCode);
      if (prof) return prof;
      const enVigueur = (x) => (x.dateDebut <= milieu && (!x.dateFin || x.dateFin >= milieu) ? 1 : 0);
      return enVigueur(b) - enVigueur(a) || b.dateDebut.localeCompare(a.dateDebut);
    });
    if (liste.length) resultat[cible] = liste[0];
  }
  return resultat;
}
exports.coefficientsApplicables = coefficientsApplicables;

exports.applicables = async (req, res) => {
  const code = req.query.entite ? texte(req.query.entite, 80).toUpperCase() : 'CD';
  const annee = c.annee(req.query.annee);
  const r = await coefficientsApplicables(code, annee);
  res.json({ entiteCode: code, annee, coefficients: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.toJSON()])) });
};

// --- Catalogue des indicateurs de couverture ---------------------------------------------------

function lireIndicateur(d, partiel = false) {
  const o = {};
  const present = (k) => d[k] !== undefined;
  if (!partiel || present('nom')) { o.nom = texte(d.nom, 160); if (!o.nom) throw erreur(400, 'Nom de l’indicateur obligatoire.'); }
  if (!partiel || present('numerateur')) { o.numerateur = texte(d.numerateur, 1000); if (!o.numerateur) throw erreur(400, 'Définition du numérateur obligatoire.'); }
  if (!partiel || present('cible')) { if (!epi.CIBLES[d.cible]) throw erreur(400, 'Dénominateur (population cible) invalide.'); o.cible = d.cible; }
  if (present('unite')) { if (!epi.UNITES_INDICATEUR.includes(d.unite)) throw erreur(400, 'Unité invalide.'); o.unite = d.unite; }
  if (present('periodicite')) { if (!epi.PERIODICITES.includes(d.periodicite)) throw erreur(400, 'Périodicité invalide.'); o.periodicite = d.periodicite; }
  if (present('source')) o.source = texte(d.source, 200);
  if (present('desagregation')) o.desagregation = (Array.isArray(d.desagregation) ? d.desagregation : []).filter((x) => epi.DESAGREGATIONS.includes(x));
  if (present('seuilReference')) {
    const v = d.seuilReference === '' || d.seuilReference == null ? null : Number(d.seuilReference);
    if (v != null && (!Number.isFinite(v) || v < 0 || v > 1000)) throw erreur(400, 'Seuil de référence invalide.');
    o.seuilReference = v;
  }
  if (present('contactsRequis')) {
    const n = Number(d.contactsRequis);
    if (!Number.isInteger(n) || n < 1 || n > 12) throw erreur(400, 'Nombre de contacts CPN requis : entier de 1 à 12.');
    o.parametres = { contactsRequis: n };
  }
  if (present('referenceValidation')) o.referenceValidation = texte(d.referenceValidation, 300);
  return o;
}

exports.listerIndicateurs = async (req, res) => {
  await initialiser();
  const liste = await IndicateurEpi.find(req.query.archives === 'oui' ? {} : { statut: { $ne: 'Archivé' } }).sort({ code: 1, version: -1 });
  res.json({ indicateurs: liste, realisations: require('../../config/moteurEpidemiologie').CODES_REALISATION, modifiable: c.aRole(req, epi.ROLES_PARAMETRAGE) });
};

exports.creerIndicateur = async (req, res) => {
  await c.exigerParametrage(req);
  const d = objet(req.body);
  const intervention = epi.PAR_INTERVENTION.get(d.intervention);
  if (!intervention) throw erreur(400, 'Intervention invalide.');
  const code = texte(d.code, 30).toUpperCase() || `COUV-${intervention.code}`;
  if (await IndicateurEpi.exists({ code })) throw erreur(409, `L’indicateur ${code} existe déjà : modifiez-le (nouvelle version).`);
  const i = new IndicateurEpi({ ...lireIndicateur({ cible: intervention.cible, ...d }), code, intervention: intervention.code, realisation: intervention.code, creePar: c.auteur(req) });
  i.tracer('Création', c.auteur(req));
  await i.validate().catch((err) => { throw erreur(400, messageValidation(err)); });
  await i.save();
  await c.tracer(req, 'epi.indicateur', { type: 'indicateur', id: i.id }, { operation: 'création', code });
  res.status(201).json(i);
};

/** Modifier un indicateur : nouvelle version soumise à validation (T20). */
exports.modifierIndicateur = async (req, res) => {
  await c.exigerParametrage(req);
  const i = await trouver(IndicateurEpi, req.params.id, 'Indicateur');
  const d = objet(req.body);
  const champs = lireIndicateur(d, true);
  const r = await c.modifier(req, 'indicateur', i, (doc) => {
    const { parametres, ...reste } = champs;
    Object.assign(doc, reste);
    if (parametres) doc.parametres = { ...(doc.parametres ?? {}), ...parametres };
  }, d.motif);
  await c.tracer(req, 'epi.indicateur', { type: 'indicateur', id: r.id }, { operation: 'modification', code: r.code, version: r.version });
  res.json(r);
};

/** Fiches en vigueur : la version validée de chaque code, sinon la plus récente (signalée « non validée »). */
async function fichesIndicateurs() {
  await initialiser();
  const toutes = await IndicateurEpi.find({ statut: { $ne: 'Archivé' } }).sort({ code: 1, version: -1 });
  const parCode = new Map();
  for (const i of toutes) {
    const actuelle = parCode.get(i.code);
    if (!actuelle || (i.statut === 'Validé' && actuelle.statut !== 'Validé')) parCode.set(i.code, i);
  }
  return [...parCode.values()];
}
exports.fichesIndicateurs = fichesIndicateurs;
