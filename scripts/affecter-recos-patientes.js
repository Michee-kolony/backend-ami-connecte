// RECO attitré des patientes enregistrées avant cette fonctionnalité : chaque patiente suivie sans
// RECO est confiée au RECO actif de sa structure qui couvre son quartier (sinon sa commune, sinon
// son aire de santé), le moins chargé. Chaque RECO est alerté de ses nouvelles patientes.
// Usage : node scripts/affecter-recos-patientes.js              → bilan, sans rien modifier
//         node scripts/affecter-recos-patientes.js --appliquer
const mongoose = require('mongoose');

process.loadEnvFile();
const Patiente = require('../models/Patiente');
const affectation = require('../config/affectationReco');

const PAR = { id: 'systeme', nom: 'Reprise des dossiers existants', role: 'Système', matricule: '' };

async function main() {
  const appliquer = process.argv.includes('--appliquer');
  await mongoose.connect(process.env.MONGODB_URI);
  const patientes = await Patiente.find({ recoId: null, statut: { $ne: 'Archivé' }, etablissementId: { $nin: [null, ''] } })
    .sort({ etablissementId: 1, numero: 1 });
  console.log(`${patientes.length} patiente(s) suivie(s) sans RECO.`);
  let confiees = 0;
  const sansReco = [];
  for (const p of patientes) {
    const reco = await affectation.choisirRecoPatiente(p);
    const ou = [p.adresse?.quartier, p.adresse?.commune].filter(Boolean).join(', ') || 'adresse non renseignée';
    if (!reco) {
      sansReco.push(`  ${p.numero} ${p.prenom} ${p.nom} (${ou})`);
      continue;
    }
    console.log(`  ${p.numero} ${p.prenom} ${p.nom} (${ou}) → ${reco.matricule} ${reco.prenom} ${reco.nom}`);
    confiees += 1;
    if (!appliquer) continue;
    const changement = affectation.placer(p, reco, PAR, 'Automatique');
    await p.save();
    await affectation.prevenir(p, changement);
  }
  if (sansReco.length) {
    console.log(`\nAucun RECO actif ne couvre le secteur de ${sansReco.length} patiente(s) : ajoutez leur quartier aux zones d'un RECO.`);
    console.log(sansReco.join('\n'));
  }
  console.log(appliquer
    ? `\n${confiees} patiente(s) confiée(s) à un RECO.`
    : `\n${confiees} patiente(s) peuvent être confiées. Pour appliquer : node scripts/affecter-recos-patientes.js --appliquer`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
