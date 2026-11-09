// Sous-fenêtre 6 — Morbidité et mortalité : enregistrement des cas de morbidité et des décès,
// signalements issus des modules AMI (à classifier, jamais comptés d'office), analyses par
// maladie, âge, sexe, période, territoire et structure. Les indicateurs ne sont calculés que sur
// des données validées, avec un numérateur et un dénominateur compatibles.
const mongoose = require('mongoose');
const CasMorbidite = require('../../models/CasMorbidite');
const Deces = require('../../models/Deces');
const Enfant = require('../../models/Enfant');
const Patiente = require('../../models/Patiente');
const Etablissement = require('../../models/Etablissement');
const EntiteGeographique = require('../../models/EntiteGeographique');
const { enregistrerNumerote } = require('../../models/validationEpi');
const epi = require('../../config/epidemiologie');
const moteur = require('../../config/moteurEpidemiologie');
const { erreur, texte, objet, jour } = require('../saisie');
const c = require('./commun');
const { personneLiee } = require('./surveillance');
const { populationValidee } = require('./demographie');

const JOUR = 86400000;
const libelleDiagnostic = (code) => epi.PAR_MALADIE.get(code)?.libelle ?? code;
const choix = (v, liste, libelle) => {
  if (!liste.includes(v)) throw erreur(400, `${libelle} invalide.`);
  return v;
};
const entierOuNull = (v, libelle, max = 130) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw erreur(400, `${libelle} invalide.`);
  return n;
};
const trancheDe = (age) => (age == null ? 'Inconnu' : epi.TRANCHES_AGE.find((t) => age >= t.min && (t.max == null || age <= t.max))?.libelle ?? 'Inconnu');
const pasFutur = (j, libelle) => {
  if (j && j > new Date().toISOString().slice(0, 10)) throw erreur(400, `${libelle} ne peut pas être dans le futur.`);
  return j;
};

async function filtreBase(q, champJour) {
  const f = {};
  if (q.dans) f.entiteCode = { $in: (await c.descendants(texte(q.dans, 80).toUpperCase())).map((e) => e.code) };
  if (q.du || q.au || q.mois || q.annee || q.trimestre) {
    const p = c.periode(q);
    f[champJour] = { $gte: p.du, $lte: p.au };
  }
  return f;
}

function masquer(req, x) {
  const j = x.toJSON();
  if (x.etablissementId !== req.etablissementId && j.personne) j.personne = { type: j.personne.type, masque: true };
  return j;
}

// --- Formulaire A : morbidité -------------------------------------------------------------------

function lireMorbidite(d, partiel = false) {
  const o = {};
  const p = (k) => !partiel || d[k] !== undefined;
  if (p('dateConsultation')) { o.dateConsultation = pasFutur(jour(d.dateConsultation, 'Date de consultation'), 'La date de consultation'); if (!o.dateConsultation) throw erreur(400, 'Date de consultation obligatoire.'); }
  if (p('service')) o.service = choix(d.service, epi.SERVICES, 'Service');
  if (p('ageAnnees')) { o.ageAnnees = entierOuNull(d.ageAnnees, 'Âge'); if (o.ageAnnees == null) throw erreur(400, 'Âge obligatoire.'); }
  if (p('sexe')) o.sexe = choix(d.sexe, epi.SEXES, 'Sexe');
  if (p('diagnostic')) { if (!epi.PAR_MALADIE.has(d.diagnostic)) throw erreur(400, 'Diagnostic invalide (nomenclature harmonisée).'); o.diagnostic = d.diagnostic; }
  if (p('classification')) o.classification = choix(d.classification, epi.CLASSIFICATIONS_MORBIDITE, 'Classification');
  if (d.categorie !== undefined) o.categorie = choix(d.categorie, ['Générale', 'Maternelle', 'Néonatale', 'Infantile'], 'Catégorie');
  if (d.complication !== undefined) o.complication = texte(d.complication, 500);
  if (d.issue !== undefined) o.issue = choix(d.issue, epi.ISSUES_MORBIDITE, 'Issue');
  if (d.dateSortie !== undefined) o.dateSortie = pasFutur(jour(d.dateSortie, 'Date de sortie'), 'La date de sortie');
  if (d.transfertDe !== undefined) o.transfertDe = texte(d.transfertDe, 200);
  if (o.dateSortie && o.dateConsultation && o.dateSortie < o.dateConsultation) throw erreur(400, 'La sortie précède la consultation.');
  return o;
}

exports.enregistrerMorbidite = async (req, res) => {
  await c.exiger(req, epi.ROLES_SAISIE, 'Saisie réservée au personnel habilité.');
  const d = objet(req.body);
  const e = await c.entite(d.entiteCode);
  const champs = lireMorbidite(d);
  const personne = await personneLiee(req, d.personneNumero);
  // Un épisode n'est pas compté deux fois : même dossier, même diagnostic, moins de 30 jours.
  if (personne && !d.forcer) {
    const debut = new Date(Date.parse(champs.dateConsultation) - 30 * JOUR).toISOString().slice(0, 10);
    const doublon = await CasMorbidite.findOne({ 'personne.numero': personne.numero, diagnostic: champs.diagnostic, dateConsultation: { $gte: debut, $lte: champs.dateConsultation }, statut: { $nin: ['Archivé', 'Rejeté'] } }).select('numero').lean();
    if (doublon) throw erreur(409, `Même épisode probable que le cas ${doublon.numero} (même dossier, même diagnostic, moins de 30 jours).`, { doublon: doublon.numero });
  }
  const m = new CasMorbidite({
    ...champs, entiteCode: e.code, etablissementId: req.etablissementId ?? null, personne, creePar: c.auteur(req),
    statut: d.brouillon ? 'Brouillon' : 'Soumis', soumission: d.brouillon ? undefined : { par: c.auteur(req), le: new Date() },
  });
  m.tracer('Enregistrement', c.auteur(req));
  await m.validate({ pathsToSkip: ['numero'] }).catch((err) => { throw erreur(400, require('../../config/erreursFr').messageValidation(err)); });
  await enregistrerNumerote(m, `MOR-${new Date().getFullYear()}`);
  await c.tracer(req, 'epi.morbidite', { type: 'morbidite', id: m.numero }, { operation: 'enregistrement', diagnostic: m.diagnostic });
  res.status(201).json(masquer(req, m));
};

exports.listerMorbidite = async (req, res) => {
  const f = await filtreBase(req.query, 'dateConsultation');
  for (const k of ['diagnostic', 'categorie', 'statut', 'service']) if (req.query[k]) f[k] = texte(req.query[k], 40);
  if (!f.statut && req.query.archives !== 'oui') f.statut = { $ne: 'Archivé' };
  const liste = await CasMorbidite.find(f).sort({ dateConsultation: -1 }).limit(1000);
  res.json(liste.map((x) => ({ ...masquer(req, x), libelleDiagnostic: libelleDiagnostic(x.diagnostic), tranche: trancheDe(x.ageAnnees) })));
};

exports.modifierMorbidite = async (req, res) => {
  await c.exiger(req, epi.ROLES_SAISIE, 'Action réservée au personnel habilité.');
  const x = await c.document('morbidite', req.params.id);
  const d = objet(req.body);
  const champs = lireMorbidite(d, true);
  const r = await c.modifier(req, 'morbidite', x, (doc) => Object.assign(doc, champs), d.motif);
  await c.tracer(req, 'epi.morbidite', { type: 'morbidite', id: r.numero }, { operation: 'modification' });
  res.json(masquer(req, r));
};

// --- Formulaire B : décès ------------------------------------------------------------------------

function lireDeces(d, partiel = false) {
  const o = {};
  const p = (k) => !partiel || d[k] !== undefined;
  if (p('dateDeces')) { o.dateDeces = pasFutur(jour(d.dateDeces, 'Date du décès'), 'La date du décès'); if (!o.dateDeces) throw erreur(400, 'Date du décès obligatoire.'); }
  if (d.ageAnnees !== undefined) o.ageAnnees = entierOuNull(d.ageAnnees, 'Âge au décès');
  if (d.ageJours !== undefined) o.ageJours = entierOuNull(d.ageJours, 'Âge en jours', 400);
  if (p('sexe')) o.sexe = choix(d.sexe, epi.SEXES, 'Sexe');
  if (p('lieu')) o.lieu = choix(d.lieu, epi.LIEUX_DECES, 'Lieu du décès');
  if (p('causeInitiale')) o.causeInitiale = choix(d.causeInitiale, epi.CAUSES_DECES, 'Cause initiale');
  if (d.causesAssociees !== undefined) o.causesAssociees = (Array.isArray(d.causesAssociees) ? d.causesAssociees : []).filter((x) => epi.CAUSES_DECES.includes(x)).slice(0, 10);
  for (const k of ['maternel', 'neonatal', 'infantile']) if (d[k] !== undefined) o[k] = choix(d[k], epi.OUI_NON_ND, `Classification (décès ${k})`);
  if (p('source')) o.source = choix(d.source, epi.SOURCES_DECES, 'Source de l’information');
  if (d.origineAmi !== undefined) o.origineAmi = texte(d.origineAmi, 30);
  return o;
}

exports.enregistrerDeces = async (req, res) => {
  await c.exiger(req, epi.ROLES_SAISIE, 'Saisie réservée au personnel habilité.');
  const d = objet(req.body);
  const e = await c.entite(d.entiteCode);
  const champs = lireDeces(d);
  if (champs.ageAnnees == null && champs.ageJours == null) throw erreur(400, 'Indiquez l’âge au décès (années ou jours).');
  const personne = await personneLiee(req, d.personneNumero);
  if (personne && await Deces.exists({ 'personne.numero': personne.numero, statut: { $nin: ['Archivé', 'Rejeté'] } })) throw erreur(409, 'Un décès est déjà enregistré pour ce dossier.');
  if (champs.origineAmi && await Deces.exists({ origineAmi: champs.origineAmi, statut: { $nin: ['Archivé', 'Rejeté'] } })) throw erreur(409, 'Ce signalement AMI est déjà enregistré.');
  const x = new Deces({
    ...champs, entiteCode: e.code, etablissementId: req.etablissementId ?? null, personne, creePar: c.auteur(req),
    statut: d.brouillon ? 'Brouillon' : 'Soumis', soumission: d.brouillon ? undefined : { par: c.auteur(req), le: new Date() },
  });
  x.tracer('Enregistrement', c.auteur(req));
  await x.validate({ pathsToSkip: ['numero'] }).catch((err) => { throw erreur(400, require('../../config/erreursFr').messageValidation(err)); });
  await enregistrerNumerote(x, `DEC-${new Date().getFullYear()}`);
  await c.tracer(req, 'epi.deces', { type: 'deces', id: x.numero }, { operation: 'enregistrement', maternel: x.maternel, neonatal: x.neonatal });
  res.status(201).json(masquer(req, x));
};

exports.listerDeces = async (req, res) => {
  const f = await filtreBase(req.query, 'dateDeces');
  for (const k of ['causeInitiale', 'statut', 'maternel', 'neonatal']) if (req.query[k]) f[k] = texte(req.query[k], 80);
  if (!f.statut && req.query.archives !== 'oui') f.statut = { $ne: 'Archivé' };
  const liste = await Deces.find(f).sort({ dateDeces: -1 }).limit(1000);
  res.json(liste.map((x) => masquer(req, x)));
};

exports.modifierDeces = async (req, res) => {
  await c.exiger(req, epi.ROLES_SAISIE, 'Action réservée au personnel habilité.');
  const x = await c.document('deces', req.params.id);
  const d = objet(req.body);
  const champs = lireDeces(d, true);
  const r = await c.modifier(req, 'deces', x, (doc) => Object.assign(doc, champs), d.motif);
  await c.tracer(req, 'epi.deces', { type: 'deces', id: r.numero }, { operation: 'modification' });
  res.json(masquer(req, r));
};

/**
 * Signalements des modules AMI à classifier (aucune deuxième saisie : le formulaire est prérempli) :
 * enfants dont le dossier est passé « Décédé » dans l'établissement de connexion, non encore
 * enregistrés dans le registre des décès.
 */
exports.signalements = async (req, res) => {
  if (!req.etablissementId) return res.json([]);
  const meres = await Patiente.distinct('_id', { etablissementId: req.etablissementId });
  const enfants = await Enfant.find({ statut: 'Décédé', $or: [{ etablissementId: req.etablissementId }, { mereId: { $in: meres } }] })
    .select('numero sexe dateNaissance neLe updatedAt').sort({ updatedAt: -1 }).limit(200).lean();
  const deja = new Set(await Deces.distinct('origineAmi', { origineAmi: { $in: enfants.map((e) => e.numero) } }));
  const fosa = await EntiteGeographique.findOne({ etablissementId: req.etablissementId }).select('code').lean();
  res.json(enfants.filter((e) => !deja.has(e.numero)).map((e) => {
    const dateSignal = e.updatedAt.toISOString().slice(0, 10);
    const ageJours = Math.max(0, Math.round((Date.parse(dateSignal) - Date.parse(e.dateNaissance)) / JOUR));
    return {
      origine: 'Module Nouveau-né / Vaccination', origineAmi: e.numero, personneNumero: e.numero, entiteCode: fosa?.code ?? null,
      sexe: e.sexe === 'F' || e.sexe === 'Féminin' ? 'Féminin' : e.sexe === 'M' || e.sexe === 'Masculin' ? 'Masculin' : 'Inconnu',
      dateSignalement: dateSignal, ageJoursApprox: ageJours, neonatal: ageJours < 28 ? 'Oui' : 'Non', infantile: ageJours < 365 ? 'Oui' : 'Non',
      note: 'Date de décès à confirmer (date du changement de statut du dossier).',
    };
  }));
};

// --- Analyse (§6.5–6.7) ---------------------------------------------------------------------------

/**
 * Analyse de la morbidité et de la mortalité d'un territoire et d'une période (données validées).
 * Fréquence = cas ÷ population de référence × unité ; TMG = décès ÷ population moyenne × 1 000 ;
 * RMM = décès maternels ÷ naissances vivantes × 100 000 ; TMN = décès néonatals ÷ naissances
 * vivantes × 1 000 ; proportion des décès maternels parmi les décès féminins (15-49 ans) ; part
 * de chaque cause parmi les décès classifiés.
 */
async function analyse(req, q) {
  const code = q.dans ? texte(q.dans, 80).toUpperCase() : 'CD';
  const e = await c.entite(code);
  const p = c.periode(q);
  const prec = c.periodePrecedente(p);
  const unite = epi.UNITES_FREQUENCE.includes(Number(q.unite)) ? Number(q.unite) : 1000;
  const codes = (await c.descendants(code)).map((x) => x.code);
  const [morbidite, deces, decesPrec, pop] = await Promise.all([
    CasMorbidite.find({ entiteCode: { $in: codes }, dateConsultation: { $gte: p.du, $lte: p.au }, statut: { $nin: ['Archivé', 'Rejeté'] } }).lean(),
    Deces.find({ entiteCode: { $in: codes }, dateDeces: { $gte: p.du, $lte: p.au }, statut: { $nin: ['Archivé', 'Rejeté'] } }).lean(),
    Deces.find({ entiteCode: { $in: codes }, dateDeces: { $gte: prec.du, $lte: prec.au }, statut: 'Validé' }).lean(),
    populationValidee(code, Number(p.du.slice(0, 4))),
  ]);
  const { etablissementIds, restreint } = await c.perimetre(req, code);
  const naissances = await moteur.realisations({ etablissementIds, du: p.du, au: p.au });
  const vm = morbidite.filter((x) => x.statut === 'Validé' && !x.transfertDe);
  const vd = deces.filter((x) => x.statut === 'Validé');
  const compter = (liste, cle) => {
    const m = new Map();
    for (const x of liste) { const k = cle(x); m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].map(([libelle, n]) => ({ libelle, n })).sort((a, b) => b.n - a.n);
  };
  const parMois = (liste, champ) => moteur.moisEntre(p.du, p.au).map((mois) => ({ mois, n: liste.filter((x) => x[champ].slice(0, 7) === mois).length }));
  const etabs = new Map((await Etablissement.find({ _id: { $in: [...new Set(vd.map((x) => x.etablissementId).filter((x) => mongoose.isValidObjectId(x)))] } }).select('nom').lean()).map((x) => [String(x._id), x.nom]));
  const entites = new Map((await EntiteGeographique.find({ code: { $in: codes } }).lean()).map((x) => [x.code, x]));
  const maternels = vd.filter((x) => x.maternel === 'Oui');
  const neonatals = vd.filter((x) => x.neonatal === 'Oui');
  const femininsConcernes = vd.filter((x) => x.sexe === 'Féminin' && x.ageAnnees != null && x.ageAnnees >= 15 && x.ageAnnees <= 49);
  const classifies = vd.filter((x) => x.causeInitiale !== 'Cause indéterminée');
  const popTotale = pop?.totale ?? null;
  const fraction = moteur.fractionAnnee(p.du, p.au);
  const ind = (codeInd, libelle, num, den, facteur, formule, extra = {}) => ({ code: codeInd, libelle, numerateur: num, denominateur: den, ...moteur.ratio(num, den, { facteur }), formule, ...extra });
  return {
    entite: { code: e.code, nom: e.nom, niveau: e.niveau }, periode: p, unite, restreint,
    population: pop ? { totale: pop.totale, annee: pop.annee, version: pop.version } : null,
    naissancesVivantes: naissances.naissancesVivantes,
    morbidite: {
      total: vm.length, nonValides: morbidite.filter((x) => x.statut !== 'Validé').length, transferts: morbidite.filter((x) => x.transfertDe).length,
      principales: compter(vm, (x) => libelleDiagnostic(x.diagnostic)).slice(0, 10),
      parAge: compter(vm, (x) => trancheDe(x.ageAnnees)), parSexe: compter(vm, (x) => x.sexe), parCategorie: compter(vm, (x) => x.categorie),
      parMois: parMois(vm, 'dateConsultation'),
      frequences: compter(vm, (x) => x.diagnostic).slice(0, 10).map(({ libelle: diag, n }) => ind(`FREQ-${diag}`, `Fréquence — ${libelleDiagnostic(diag)}`, n, popTotale, unite,
        `Cas enregistrés ÷ population de référence × ${unite.toLocaleString('fr-FR')}`)),
    },
    mortalite: {
      total: vd.length, nonValides: deces.filter((x) => x.statut !== 'Validé').length,
      parCause: compter(vd, (x) => x.causeInitiale), parMois: parMois(vd, 'dateDeces'),
      maternelsParMois: parMois(maternels, 'dateDeces'), neonatalsParMois: parMois(neonatals, 'dateDeces'),
      maternelsParStructure: compter(maternels, (x) => etabs.get(x.etablissementId) ?? 'Communauté / autre'),
      neonatalsParZone: compter(neonatals, (x) => {
        const ch = entites.get(x.entiteCode)?.chemin ?? [];
        const zone = ch.map((k) => entites.get(k)).find((z) => z?.niveau === 'Zone de santé');
        return zone?.nom ?? entites.get(x.entiteCode)?.nom ?? x.entiteCode;
      }),
      precedent: decesPrec.length, variation: moteur.variation(vd.length, decesPrec.length).valeur,
      indicateurs: [
        ind('TMG', 'Taux de mortalité générale', vd.length, popTotale == null ? null : Math.round(popTotale * fraction), 1000,
          'Décès de la période ÷ population moyenne de la période × 1 000 (population annuelle proratisée à la durée de la période)'),
        ind('PROP-DM', 'Proportion des décès maternels parmi les décès féminins (15-49 ans)', maternels.length, femininsConcernes.length, 100,
          'Décès maternels ÷ décès féminins de 15 à 49 ans × 100 (à ne pas confondre avec le ratio de mortalité maternelle)'),
        ind('RMM', 'Ratio de mortalité maternelle', maternels.length, naissances.naissancesVivantes, 100000, 'Décès maternels ÷ naissances vivantes × 100 000',
          { note: 'Naissances vivantes enregistrées dans les modules AMI (structures du périmètre).' }),
        ind('TMN', 'Taux de mortalité néonatale', neonatals.length, naissances.naissancesVivantes, 1000, 'Décès néonatals ÷ naissances vivantes × 1 000'),
        ...compter(classifies, (x) => x.causeInitiale).slice(0, 8).map(({ libelle, n }) => ind(`CAUSE-${libelle}`, `Part des décès — ${libelle}`, n, classifies.length, 100,
          'Décès attribués à la cause ÷ total des décès classifiés × 100')),
      ],
      signalementsAmi: naissances.signalements,
    },
    incompletes: {
      morbiditeNonValidee: morbidite.filter((x) => x.statut !== 'Validé').length,
      decesNonValides: deces.filter((x) => x.statut !== 'Validé').length,
      causeIndeterminee: vd.filter((x) => x.causeInitiale === 'Cause indéterminée').length,
      classificationMaternelleNonDeterminee: vd.filter((x) => x.sexe === 'Féminin' && x.maternel === 'Non déterminé' && x.ageAnnees >= 15 && x.ageAnnees <= 49).length,
      populationAbsente: !pop,
    },
  };
}
exports.calculAnalyse = analyse;

exports.analyse = async (req, res) => {
  res.json(await analyse(req, { ...req.query, dans: req.query.dans || await c.entiteParDefaut(req) }));
};
