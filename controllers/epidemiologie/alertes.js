// Sous-fenêtre 8 — Alertes et insuffisances : de la détection à la correction suivie.
//   - contrôles structurels automatiques (données manquantes, non validées, expirées, cibles non
//     réparties, événements sans investigation, actions en retard) : aucun seuil inventé ;
//   - règles à seuil (couverture, abandon, zéro dose, cas, décès) : configurées, documentées et
//     ACTIVÉES par un responsable avec la référence du document qui fixe le seuil ;
//   - une seule alerte ouverte par problème (les répétitions incrémentent les occurrences), reliée
//     au problème déjà identifié s'il a été clôturé ; traitement : responsable, échéance, action
//     corrective, preuve, résultat ; clôture impossible sans résultat ou justification.
const AlerteEpi = require('../../models/AlerteEpi');
const RegleAlerteEpi = require('../../models/RegleAlerteEpi');
const EntiteGeographique = require('../../models/EntiteGeographique');
const PopulationReference = require('../../models/PopulationReference');
const CoefficientDemographique = require('../../models/CoefficientDemographique');
const CalculCible = require('../../models/CalculCible');
const PlanCible = require('../../models/PlanCible');
const EvenementSanitaire = require('../../models/EvenementSanitaire');
const CasSurveillance = require('../../models/CasSurveillance');
const Deces = require('../../models/Deces');
const Soignant = require('../../models/Soignant');
const { enregistrerNumerote, numeroSuivant } = require('../../models/validationEpi');
const epi = require('../../config/epidemiologie');
const moteur = require('../../config/moteurEpidemiologie');
const { erreur, texte, objet, jour } = require('../saisie');
const c = require('./commun');
const { calculCouvertures } = require('./couvertures');

const JOUR = 86400000;
const aujourdhui = () => moteur.jourKinshasa(new Date());
const plusJours = (n) => new Date(Date.now() + n * JOUR).toISOString().slice(0, 10);
const comparer = (v, op, s) => ({ '<': v < s, '<=': v <= s, '>': v > s, '>=': v >= s }[op]);

// --- Règles --------------------------------------------------------------------------------------

function lireRegle(d, partiel = false) {
  const o = {};
  const p = (k) => !partiel || d[k] !== undefined;
  if (p('nom')) { o.nom = texte(d.nom, 160); if (!o.nom) throw erreur(400, 'Nom de l’alerte obligatoire.'); }
  if (p('indicateur')) {
    const ind = epi.INDICATEURS_ALERTE.find((x) => x.code === d.indicateur);
    if (!ind) throw erreur(400, 'Indicateur concerné invalide.');
    o.indicateur = ind.code;
    if (!d.domaine) o.domaine = ind.domaine;
  }
  if (d.domaine !== undefined && d.domaine !== '') { if (!epi.DOMAINES_ALERTE.includes(d.domaine)) throw erreur(400, 'Domaine invalide.'); o.domaine = d.domaine; }
  if (d.parametre !== undefined) o.parametre = texte(d.parametre, 40);
  if (p('operateur')) { if (!epi.OPERATEURS.includes(d.operateur)) throw erreur(400, 'Condition invalide.'); o.operateur = d.operateur; }
  if (d.seuil !== undefined) {
    const s = d.seuil === '' || d.seuil == null ? null : Number(String(d.seuil).replace(',', '.'));
    if (s != null && !Number.isFinite(s)) throw erreur(400, 'Seuil invalide.');
    o.seuil = s;
  }
  if (p('priorite')) { if (!epi.PRIORITES.includes(d.priorite)) throw erreur(400, 'Niveau de priorité invalide.'); o.priorite = d.priorite; }
  if (d.destinataire !== undefined) o.destinataire = texte(d.destinataire, 160);
  if (d.delaiTraitementJours !== undefined) {
    const n = Number(d.delaiTraitementJours);
    if (!Number.isInteger(n) || n < 1 || n > 365) throw erreur(400, 'Délai de traitement : 1 à 365 jours.');
    o.delaiTraitementJours = n;
  }
  if (d.message !== undefined) o.message = texte(d.message, 1000);
  if (d.actionRecommandee !== undefined) o.actionRecommandee = texte(d.actionRecommandee, 1000);
  return o;
}

async function trouverRegle(code) {
  const r = await RegleAlerteEpi.findOne({ code: texte(code, 30) });
  if (!r) throw erreur(404, 'Règle introuvable.');
  return r;
}

function nouvelleVersion(r, par, operation) {
  r.historique.push({ ...Object.fromEntries(RegleAlerteEpi.CHAMPS_CONTENU.map((k) => [k, r.get(k)])), version: r.version, operation, par, le: new Date() });
  r.version += 1;
  r.modifiePar = par;
}

exports.listerRegles = async (req, res) => {
  res.json({ regles: await RegleAlerteEpi.find(req.query.archives === 'oui' ? {} : { statut: { $ne: 'Archivée' } }).sort({ code: 1 }), modifiable: c.aRole(req, epi.ROLES_PARAMETRAGE) });
};

exports.creerRegle = async (req, res) => {
  await c.exigerParametrage(req);
  const d = objet(req.body);
  const o = lireRegle(d);
  if (d.entiteCode) o.entiteCode = (await c.entite(d.entiteCode)).code;
  const r = new RegleAlerteEpi({ ...o, creePar: c.auteur(req) });
  await enregistrerNumerote(r, 'ALR-REG', 'code');
  await c.tracer(req, 'epi.alerte.regle', { type: 'regle', id: r.code }, { operation: 'création', statut: r.statut });
  res.status(201).json(r);
};

/** Toute modification crée une version et désactive la règle jusqu'à sa nouvelle activation. */
exports.modifierRegle = async (req, res) => {
  await c.exigerParametrage(req);
  const r = await trouverRegle(req.params.code);
  if (r.statut === 'Archivée') throw erreur(409, 'Règle archivée.');
  const d = objet(req.body);
  const o = lireRegle(d, true);
  if (d.entiteCode !== undefined) o.entiteCode = d.entiteCode ? (await c.entite(d.entiteCode)).code : null;
  nouvelleVersion(r, c.auteur(req), 'Modification');
  Object.assign(r, o, { statut: 'Brouillon', responsableValidation: '', referenceValidation: '' });
  await r.save();
  await c.tracer(req, 'epi.alerte.regle', { type: 'regle', id: r.code }, { operation: 'modification', version: r.version });
  res.json(r);
};

exports.activerRegle = async (req, res) => {
  await c.exigerValidation(req);
  const r = await trouverRegle(req.params.code);
  const d = objet(req.body);
  if (r.seuil == null) throw erreur(400, 'Seuil non défini : les seuils doivent être fixés et validés par les responsables sanitaires avant activation.');
  const ind = epi.INDICATEURS_ALERTE.find((x) => x.code === r.indicateur);
  if (ind?.parametre && !r.parametre) throw erreur(400, `Précisez le paramètre de la règle (${ind.parametre}).`);
  const responsableValidation = texte(d.responsableValidation, 200);
  const referenceValidation = texte(d.referenceValidation, 300);
  if (!responsableValidation || !referenceValidation) throw erreur(400, 'Indiquez le responsable de la validation et la référence du document qui fixe le seuil.');
  nouvelleVersion(r, c.auteur(req), 'Activation');
  Object.assign(r, { statut: 'Active', responsableValidation, referenceValidation });
  await r.save();
  await c.tracer(req, 'epi.alerte.regle', { type: 'regle', id: r.code }, { operation: 'activation', version: r.version });
  res.json(r);
};

exports.statutRegle = async (req, res) => {
  await c.exigerParametrage(req);
  const r = await trouverRegle(req.params.code);
  const statut = { suspendre: 'Suspendue', archiver: 'Archivée' }[req.params.action];
  if (!statut) throw erreur(404, 'Action inconnue.');
  nouvelleVersion(r, c.auteur(req), statut);
  r.statut = statut;
  await r.save();
  await c.tracer(req, 'epi.alerte.regle', { type: 'regle', id: r.code }, { operation: statut });
  res.json(r);
};

// --- Détection -----------------------------------------------------------------------------------

/**
 * Crée ou met à jour l'alerte d'un problème. Une alerte ouverte de même clé est réutilisée
 * (occurrences + 1) ; si le même problème avait été clôturé, la nouvelle alerte y est reliée.
 */
async function signaler(a, bilan) {
  const ouverte = await AlerteEpi.findOne({ cle: a.cle, statut: { $in: epi.STATUTS_ALERTE_OUVERTS } });
  if (ouverte) {
    ouverte.occurrences += 1;
    ouverte.derniereOccurrence = new Date();
    if (a.declencheur) ouverte.declencheur = a.declencheur;
    await ouverte.save();
    bilan.repetees += 1;
    return ouverte;
  }
  const precedente = await AlerteEpi.findOne({ cle: a.cle }).sort({ createdAt: -1 }).select('numero').lean();
  const alerte = new AlerteEpi({ ...a, problemeLie: precedente?.numero ?? null, echeance: a.echeance ?? plusJours(a.delai ?? 7) });
  alerte.historique.push({ action: 'Déclenchement', nouveauStatut: 'Nouvelle', details: a.declencheur?.donnee ?? '', le: new Date() });
  await enregistrerNumerote(alerte, 'ALT');
  bilan.creees += 1;
  return alerte;
}
exports.signaler = signaler;

/** Résout automatiquement une alerte structurelle dont le problème a disparu. */
async function resoudreAuto(cles, prefixe, bilan) {
  // Préfixe littéral (le « | » des clés n'est pas une alternative d'expression régulière).
  const motif = `^${prefixe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  const ouvertes = await AlerteEpi.find({ cle: { $regex: motif }, statut: { $in: epi.STATUTS_ALERTE_OUVERTS }, 'declencheur.automatique': true });
  for (const a of ouvertes) {
    if (cles.has(a.cle)) continue;
    a.historique.push({ action: 'Résolution automatique', ancienStatut: a.statut, nouveauStatut: 'Résolue', details: 'Condition de déclenchement disparue à la dernière détection.', le: new Date() });
    a.statut = 'Résolue';
    a.resolueLe = new Date();
    a.resultat ||= 'Condition de déclenchement disparue (constat automatique).';
    await a.save();
    bilan.resolues += 1;
  }
}

async function evaluerRegle(req, r, entite, bilan) {
  const an = new Date().getFullYear();
  const au = aujourdhui();
  const mois = au.slice(0, 7);
  let valeur = null;
  let donnee = '';
  let periode = `${an}`;
  if (['COUVERTURE', 'ABANDON_PENTA', 'ABANDON_CPN', 'ZERO_DOSE'].includes(r.indicateur)) {
    const x = await calculCouvertures(req, { entiteCode: entite.code, du: `${an}-01-01`, au, mensuel: false });
    periode = `${an} (au ${au})`;
    if (r.indicateur === 'COUVERTURE') {
      const i = x.indicateurs.find((k) => k.code === r.parametre);
      valeur = i?.valeur ?? null;
      donnee = i ? `${i.nom} : ${i.numerateur} / ${i.denominateur}` : '';
    } else if (r.indicateur === 'ZERO_DOSE') {
      valeur = x.zeroDose.zeroDose;
      donnee = `${valeur} enfant(s) zéro dose sur ${x.zeroDose.enfantsSuivis} suivis`;
    } else {
      const ab = x.abandons[r.indicateur === 'ABANDON_PENTA' ? 0 : 1];
      valeur = ab.valeur;
      donnee = `${ab.libelle} : ${ab.numerateur} / ${ab.denominateur}`;
    }
  } else {
    const codes = (await c.descendants(entite.code)).map((e) => e.code);
    const compterCas = async (du, fin) => (await CasSurveillance.find({ entiteCode: { $in: codes }, maladie: r.parametre, statut: { $nin: ['Archivé', 'Rejeté'] }, classification: { $ne: 'Non-cas' } }))
      .filter((x) => { const d = x.dateReference(); return d >= du && d <= fin; }).length;
    const du = `${mois}-01`;
    periode = `mois ${mois}`;
    if (r.indicateur === 'CAS_MALADIE') {
      valeur = await compterCas(du, au);
      donnee = `${valeur} cas notifiés (${epi.PAR_MALADIE.get(r.parametre)?.libelle ?? r.parametre})`;
    } else if (r.indicateur === 'HAUSSE_CAS') {
      const p = c.periodePrecedente({ du, au });
      const actuel = await compterCas(du, au);
      const avant = await compterCas(p.du, p.au);
      valeur = moteur.variation(actuel, avant).valeur;
      donnee = `${actuel} cas contre ${avant} sur la période précédente`;
    } else {
      const champ = r.indicateur === 'DECES_MATERNELS' ? 'maternel' : 'neonatal';
      valeur = await Deces.countDocuments({ entiteCode: { $in: codes }, [champ]: 'Oui', dateDeces: { $gte: du, $lte: au }, statut: { $nin: ['Archivé', 'Rejeté'] } });
      donnee = `${valeur} décès ${champ === 'maternel' ? 'maternel(s)' : 'néonatal(s)'}`;
    }
  }
  if (valeur == null || !comparer(valeur, r.operateur, r.seuil)) return;
  await signaler({
    cle: `REG|${r.code}|${entite.code}|${periode.slice(0, 7)}`, domaine: r.domaine, titre: r.nom, message: r.message || donnee, actionRecommandee: r.actionRecommandee,
    priorite: r.priorite, entiteCode: entite.code, territoire: entite.nom, periode, delai: r.delaiTraitementJours,
    declencheur: { automatique: true, regleCode: r.code, regleVersion: r.version, indicateur: r.indicateur, valeur, seuil: r.seuil, operateur: r.operateur, donnee },
  }, bilan);
}

/**
 * Détection : contrôles structurels sur le territoire (consolidation : tout le référentiel, sinon la
 * structure de connexion et ses entités parentes), puis règles actives.
 */
async function detecter(req) {
  const bilan = { creees: 0, repetees: 0, resolues: 0, regles: 0 };
  const an = new Date().getFullYear();
  const auj = aujourdhui();
  const racine = c.aRole(req, epi.ROLES_CONSOLIDATION) ? 'CD' : await c.entiteParDefaut(req);
  const entites = await EntiteGeographique.find({ chemin: racine, actif: true, niveau: { $in: ['Province', 'Zone de santé', 'Aire de santé', 'Formation sanitaire'] } }).lean();
  const auto = (cle, domaine, titre, message, priorite, entite, donnee, action = '') => ({
    cle, domaine, titre, message, priorite, entiteCode: entite?.code ?? null, territoire: entite?.nom ?? '', periode: String(an), actionRecommandee: action,
    declencheur: { automatique: true, donnee },
  });
  const cles = new Set();
  const lever = async (a) => { cles.add(a.cle); await signaler(a, bilan); };

  // Coefficients : chaque population cible doit avoir un coefficient validé en vigueur au national.
  for (const [cible, libelle] of Object.entries(epi.CIBLES)) {
    const valide = await CoefficientDemographique.findOne({ cible, entiteCode: 'CD', statut: 'Validé', dateDebut: { $lte: auj }, $or: [{ dateFin: null }, { dateFin: { $gte: auj } }] }).lean();
    if (valide) continue;
    const expire = await CoefficientDemographique.findOne({ cible, statut: 'Validé', dateFin: { $lt: auj } }).sort({ dateFin: -1 }).lean();
    await lever(auto(`STR|COEF|${cible}`, 'Coefficients', expire ? `Coefficient expiré : ${libelle}` : `Coefficient non validé : ${libelle}`,
      expire ? `Le coefficient ${expire.code} a expiré le ${expire.dateFin} sans nouvelle version validée.` : 'Aucun coefficient national validé et en vigueur : les populations cibles ne peuvent pas être calculées.',
      'Élevée', { code: 'CD', nom: 'National' }, `Cible ${cible}`, 'Faire valider le coefficient (sous-fenêtre 2) avec sa source officielle.'));
  }
  // Démographie, calculs et planification, entité par entité (niveaux opérationnels).
  const pops = new Map((await PopulationReference.find({ annee: an, entiteCode: { $in: entites.map((e) => e.code) }, statut: { $ne: 'Archivé' } }).sort({ version: -1 }).lean())
    .reverse().map((p) => [p.entiteCode, p]));
  const calculs = new Set(await CalculCible.distinct('entiteCode', { annee: an, statut: 'Validé' }));
  const plans = await PlanCible.find({ annee: an, statut: { $nin: ['Archivé', 'Rejeté'] } }).select('entiteCode intervention').lean();
  for (const e of entites) {
    const p = pops.get(e.code);
    if (!p || p.statut !== 'Validé') {
      await lever(auto(`STR|POP|${e.code}|${an}`, 'Démographie', p ? 'Population non validée' : 'Population non renseignée',
        p ? `Population ${an} en statut « ${p.statut} » pour ${e.nom}.` : `Aucune population de référence ${an} pour ${e.nom}.`, 'Modérée', e, `${e.niveau} ${e.code}`,
        'Renseigner puis faire valider la population de référence (sous-fenêtre 1).'));
    } else {
      const pop = await PopulationReference.findById(p._id);
      if (pop.anomalies().some((x) => x.startsWith('Hommes') || x.startsWith('Somme'))) {
        await lever(auto(`STR|QUAL|POP|${e.code}|${an}`, 'Qualité des données', 'Données démographiques incohérentes', pop.anomalies().join(' '), 'Modérée', e, `Population v${pop.version}`,
          'Corriger la répartition par sexe ou par âge (nouvelle version).'));
      }
      if (!calculs.has(e.code)) {
        await lever(auto(`STR|CAL|${e.code}|${an}`, 'Calculs', 'Populations cibles non calculées ou non validées', `Population validée mais aucun calcul de cibles validé pour ${e.nom} en ${an}.`,
          'Modérée', e, `${e.niveau} ${e.code}`, 'Lancer et faire valider le calcul des populations cibles (sous-fenêtre 3).'));
      } else {
        const manquants = ['CPN1', 'PENTA3'].filter((i) => !plans.some((x) => x.entiteCode === e.code && x.intervention === i));
        if (manquants.length) {
          await lever(auto(`STR|PLN|${e.code}|${an}`, 'Planification', 'Cible non répartie', `Aucun plan ${an} pour : ${manquants.join(', ')} (${e.nom}).`,
            'Information', e, manquants.join(', '), 'Créer et faire valider les plans de ces interventions (sous-fenêtre 4).'));
        }
      }
    }
  }
  // Surveillance : événements prioritaires sans investigation.
  const evenements = await EvenementSanitaire.find({ entiteCode: { $in: [...entites.map((e) => e.code), racine] }, etat: { $ne: 'Clôturé' }, priorite: { $in: ['Critique', 'Élevée'] }, investigation: { $exists: false } }).lean();
  const nomDe = new Map(entites.map((e) => [e.code, e]));
  for (const ev of evenements) {
    await lever(auto(`STR|EVT|${ev.numero}`, 'Surveillance', 'Événement nécessitant une investigation',
      `${ev.numero} — ${epi.PAR_MALADIE.get(ev.maladie)?.libelle ?? ev.maladie} : ${ev.casSignales} cas, ${ev.decesSignales} décès, priorité ${ev.priorite}, sans investigation.`,
      ev.priorite === 'Critique' ? 'Critique' : 'Élevée', nomDe.get(ev.entiteCode) ?? { code: ev.entiteCode, nom: ev.entiteCode }, ev.numero, 'Désigner l’équipe d’investigation et suivre le circuit officiel de notification.'));
  }
  // Opérationnel : actions correctives non exécutées dans le délai.
  const enRetard = await AlerteEpi.find({ statut: { $in: epi.STATUTS_ALERTE_OUVERTS }, echeance: { $lt: auj }, domaine: { $ne: 'Opérationnel' } }).lean();
  for (const a of enRetard) {
    await lever(auto(`STR|OPS|${a.numero}`, 'Opérationnel', 'Action corrective non exécutée dans le délai', `${a.numero} « ${a.titre} » : échéance du ${a.echeance} dépassée.`,
      'Élevée', a.entiteCode ? { code: a.entiteCode, nom: a.territoire } : null, a.numero, 'Relancer le responsable ou réaffecter l’alerte.'));
  }
  await resoudreAuto(cles, 'STR|', bilan);

  // Règles à seuil actives (périmètre de la règle, ou le territoire de détection).
  const regles = await RegleAlerteEpi.find({ statut: 'Active', seuil: { $ne: null } });
  for (const r of regles) {
    bilan.regles += 1;
    const perimetre = r.entiteCode ? await EntiteGeographique.findOne({ code: r.entiteCode }).lean() : await EntiteGeographique.findOne({ code: racine }).lean();
    if (!perimetre) continue;
    const cibles = [perimetre, ...(await EntiteGeographique.find({ chemin: perimetre.code, niveau: 'Formation sanitaire', actif: true }).lean())];
    for (const e of cibles.slice(0, 300)) await evaluerRegle(req, r, e, bilan);
  }
  return bilan;
}
exports.detecter = detecter;

exports.detection = async (req, res) => {
  await c.exigerPlanification(req);
  const bilan = await detecter(req);
  await c.tracer(req, 'epi.alerte', { type: 'detection', id: null }, bilan);
  res.json(bilan);
};

// --- Alertes : consultation et traitement -------------------------------------------------------

const retardJours = (a) => (epi.STATUTS_ALERTE_OUVERTS.includes(a.statut) && a.echeance && a.echeance < aujourdhui()
  ? Math.round((Date.parse(aujourdhui()) - Date.parse(a.echeance)) / JOUR) : null);
const vue = (a) => ({ ...(a.toJSON ? a.toJSON() : a), retardJours: retardJours(a) });

async function filtreAlertes(q) {
  const f = {};
  if (q.dans) f.entiteCode = { $in: (await c.descendants(texte(q.dans, 80).toUpperCase())).map((e) => e.code) };
  for (const k of ['statut', 'domaine', 'priorite']) if (q[k]) f[k] = texte(q[k], 40);
  if (q.ouvertes === 'oui') f.statut = { $in: epi.STATUTS_ALERTE_OUVERTS };
  if (q.du || q.au || q.mois || q.annee) {
    const p = c.periode(q);
    f.createdAt = { $gte: moteur.instantJour(p.du), $lt: new Date(moteur.instantJour(p.au).getTime() + JOUR) };
  }
  return f;
}

exports.lister = async (req, res) => {
  const liste = await AlerteEpi.find(await filtreAlertes(req.query)).sort({ statut: 1, createdAt: -1 }).limit(1000);
  const rang = { Critique: 0, Élevée: 1, Modérée: 2, Information: 3 };
  res.json(liste.map(vue).sort((a, b) => Number(!epi.STATUTS_ALERTE_OUVERTS.includes(a.statut)) - Number(!epi.STATUTS_ALERTE_OUVERTS.includes(b.statut)) || rang[a.priorite] - rang[b.priorite]));
};

async function trouver(numero) {
  const a = await AlerteEpi.findOne({ numero: texte(numero, 30) });
  if (!a) throw erreur(404, 'Alerte introuvable.');
  return a;
}

exports.obtenir = async (req, res) => res.json(vue(await trouver(req.params.numero)));

/** Signalement manuel (qualité des données, insuffisance constatée sur le terrain). */
exports.creer = async (req, res) => {
  await c.exiger(req, epi.ROLES_SAISIE, 'Action réservée au personnel habilité.');
  const d = objet(req.body);
  if (!epi.DOMAINES_ALERTE.includes(d.domaine)) throw erreur(400, 'Domaine invalide.');
  if (!epi.PRIORITES.includes(d.priorite)) throw erreur(400, 'Priorité invalide.');
  const titre = texte(d.titre, 200);
  if (!titre) throw erreur(400, 'Le titre de l’alerte est obligatoire.');
  const e = d.entiteCode ? await c.entite(d.entiteCode) : null;
  const a = new AlerteEpi({
    cle: `MAN|${await numeroSuivant(AlerteEpi, 'ALT')}`, domaine: d.domaine, titre, message: texte(d.message, 2000), actionRecommandee: texte(d.actionRecommandee, 1000),
    priorite: d.priorite, entiteCode: e?.code ?? null, territoire: e?.nom ?? '', periode: texte(d.periode, 40), echeance: jour(d.echeance, 'Échéance') ?? plusJours(7),
    declencheur: { automatique: false, donnee: texte(d.donnee, 300) }, creePar: c.auteur(req),
  });
  a.historique.push({ action: 'Signalement manuel', nouveauStatut: 'Nouvelle', par: c.auteur(req), le: new Date() });
  await enregistrerNumerote(a, 'ALT');
  await c.tracer(req, 'epi.alerte', { type: 'alerte', id: a.numero }, { operation: 'création manuelle', domaine: a.domaine });
  res.status(201).json(vue(a));
};

function passer(req, a, statut, action, details = '') {
  a.historique.push({ action, ancienStatut: a.statut, nouveauStatut: statut, details, par: c.auteur(req), le: new Date() });
  a.statut = statut;
}

exports.responsables = async (req, res) => {
  const filtre = { statut: 'Actif', ...(req.etablissementId ? { 'affectations.etablissementId': req.etablissementId } : {}) };
  const s = await Soignant.find(filtre).select('prenom nom role').sort({ nom: 1 }).limit(300).lean();
  res.json(s.map((x) => ({ id: String(x._id), nom: `${x.prenom} ${x.nom}`, fonction: x.role })));
};

/** Affectation : un responsable et une échéance (T12). */
exports.attribuer = async (req, res) => {
  await c.exigerPlanification(req);
  const a = await trouver(req.params.numero);
  if (!epi.STATUTS_ALERTE_OUVERTS.includes(a.statut)) throw erreur(409, 'Alerte déjà résolue ou clôturée.');
  const d = objet(req.body);
  let responsable;
  if (d.responsableId) {
    const s = await Soignant.findById(texte(d.responsableId, 40)).select('prenom nom role').lean().catch(() => null);
    if (!s) throw erreur(400, 'Responsable introuvable.');
    responsable = { id: String(s._id), nom: `${s.prenom} ${s.nom}`, fonction: s.role };
  } else {
    const nom = texte(d.responsable, 160);
    if (!nom) throw erreur(400, 'Désignez le responsable du traitement.');
    responsable = { id: null, nom, fonction: texte(d.fonction, 120) };
  }
  const echeance = jour(d.echeance, 'Échéance');
  if (!echeance) throw erreur(400, 'L’échéance est obligatoire.');
  a.responsable = responsable;
  a.echeance = echeance;
  passer(req, a, a.statut === 'Nouvelle' ? 'Attribuée' : a.statut, 'Affectation', `${responsable.nom}, échéance ${echeance}`);
  await a.save();
  await c.tracer(req, 'epi.alerte', { type: 'alerte', id: a.numero }, { operation: 'affectation' });
  res.json(vue(a));
};

/** Diagnostic et action corrective planifiée (En cours). */
exports.traiter = async (req, res) => {
  await c.exiger(req, epi.ROLES_SAISIE, 'Action réservée au personnel habilité.');
  const a = await trouver(req.params.numero);
  if (!epi.STATUTS_ALERTE_OUVERTS.includes(a.statut)) throw erreur(409, 'Alerte déjà résolue ou clôturée.');
  if (!a.responsable) throw erreur(409, 'Affectez d’abord un responsable à l’alerte.');
  const d = objet(req.body);
  if (d.diagnostic !== undefined) a.diagnostic = texte(d.diagnostic, 4000);
  if (d.actionCorrective !== undefined) a.actionCorrective = texte(d.actionCorrective, 4000);
  if (d.datePrevue !== undefined) a.datePrevue = jour(d.datePrevue, 'Date prévue');
  if (!a.actionCorrective) throw erreur(400, 'Décrivez l’action corrective à mener.');
  passer(req, a, 'En cours', 'Action corrective', a.actionCorrective.slice(0, 200));
  await a.save();
  await c.tracer(req, 'epi.alerte', { type: 'alerte', id: a.numero }, { operation: 'action corrective' });
  res.json(vue(a));
};

exports.resoudre = async (req, res) => {
  await c.exiger(req, epi.ROLES_SAISIE, 'Action réservée au personnel habilité.');
  const a = await trouver(req.params.numero);
  if (!epi.STATUTS_ALERTE_OUVERTS.includes(a.statut)) throw erreur(409, 'Alerte déjà résolue ou clôturée.');
  const d = objet(req.body);
  const resultat = texte(d.resultat, 4000);
  if (!resultat) throw erreur(400, 'Indiquez le résultat obtenu.');
  a.resultat = resultat;
  a.dateRealisation = jour(d.dateRealisation, 'Date de réalisation') ?? aujourdhui();
  if (d.preuve !== undefined) a.preuve = texte(d.preuve, 1000);
  a.resolueLe = new Date();
  passer(req, a, 'Résolue', 'Résolution', resultat.slice(0, 200));
  await a.save();
  await c.tracer(req, 'epi.alerte', { type: 'alerte', id: a.numero }, { operation: 'résolution' });
  res.json(vue(a));
};

/** Clôture et évaluation : impossible sans résultat ou justification. */
exports.cloturer = async (req, res) => {
  await c.exigerPlanification(req);
  const a = await trouver(req.params.numero);
  if (a.statut === 'Clôturée') throw erreur(409, 'Alerte déjà clôturée.');
  const d = objet(req.body);
  const evaluation = texte(d.evaluation, 4000);
  if (!a.resultat && !evaluation) throw erreur(400, 'Une alerte ne peut pas être clôturée sans résultat ou justification.');
  a.evaluation = evaluation;
  a.clotureLe = new Date();
  passer(req, a, 'Clôturée', 'Clôture', evaluation.slice(0, 200));
  await a.save();
  await c.tracer(req, 'epi.alerte', { type: 'alerte', id: a.numero }, { operation: 'clôture' });
  res.json(vue(a));
};

/** Relier une alerte répétée à un problème déjà identifié. */
exports.lier = async (req, res) => {
  await c.exigerPlanification(req);
  const a = await trouver(req.params.numero);
  const autre = await trouver(objet(req.body).numero);
  if (autre.numero === a.numero) throw erreur(400, 'Une alerte ne peut pas être reliée à elle-même.');
  a.problemeLie = autre.numero;
  a.historique.push({ action: 'Reliée à un problème identifié', details: autre.numero, par: c.auteur(req), le: new Date() });
  await a.save();
  res.json(vue(a));
};

// --- Tableau des alertes (§8.6–8.8) -------------------------------------------------------------

async function tableau(q) {
  const f = await filtreAlertes(q);
  const liste = await AlerteEpi.find(f).lean();
  const compter = (cle) => {
    const m = new Map();
    for (const a of liste) { const k = cle(a) || 'Non précisé'; m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].map(([libelle, n]) => ({ libelle, n })).sort((a, b) => b.n - a.n);
  };
  const resolues = liste.filter((a) => ['Résolue', 'Clôturée'].includes(a.statut));
  const delais = resolues.filter((a) => a.resolueLe).map((a) => (new Date(a.resolueLe) - new Date(a.createdAt)) / JOUR);
  const parMois = new Map();
  for (const a of liste) { const k = moteur.jourKinshasa(a.createdAt).slice(0, 7); parMois.set(k, (parMois.get(k) ?? 0) + 1); }
  return {
    total: liste.length,
    ouvertes: liste.filter((a) => epi.STATUTS_ALERTE_OUVERTS.includes(a.statut)).length,
    enRetard: liste.filter((a) => retardJours(a) != null).length,
    critiquesOuvertes: liste.filter((a) => a.priorite === 'Critique' && epi.STATUTS_ALERTE_OUVERTS.includes(a.statut)).length,
    tauxResolution: { ...moteur.ratio(resolues.length, liste.length), numerateur: resolues.length, denominateur: liste.length,
      formule: 'Alertes résolues ou clôturées ÷ alertes déclenchées sur la période (tous statuts) × 100' },
    delaiMoyenTraitementJours: delais.length ? Math.round((delais.reduce((s, x) => s + x, 0) / delais.length) * 10) / 10 : null,
    parPriorite: epi.PRIORITES.map((p) => ({ libelle: p, n: liste.filter((a) => a.priorite === p).length })),
    parStatut: epi.STATUTS_ALERTE.map((s) => ({ libelle: s, n: liste.filter((a) => a.statut === s).length })),
    parCategorie: compter((a) => a.domaine),
    parZone: compter((a) => a.territoire).slice(0, 15),
    parMois: [...parMois.entries()].sort().map(([mois, n]) => ({ mois, n })),
  };
}
exports.calculTableau = tableau;

exports.tableau = async (req, res) => res.json(await tableau(req.query));
