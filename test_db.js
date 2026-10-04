import env from './src/config/env.js';
import mongoose from 'mongoose';

async function run() {
  await mongoose.connect(env.mongodbUri);
  const Deployment = mongoose.model('Deployment', new mongoose.Schema({}, { strict: false, collection: 'deployments' }));
  const Mobilisation = mongoose.model('Mobilisation', new mongoose.Schema({}, { strict: false, collection: 'mobilisations' }));
  
  const startOfThisMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const deploymentFilter = {
    startDate: { $lte: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59, 999) },
    $or: [{ endDate: null }, { endDate: { $gte: startOfThisMonth } }],
    archived: { $ne: true },
  };
  
  const activeDeployments = await Deployment.find(deploymentFilter).lean();
  let dashboardSum = 0;
  for (const d of activeDeployments) {
    if (d.mobilisation) {
      const mob = await Mobilisation.findById(d.mobilisation).lean();
      dashboardSum += (mob.profitPerHour || 0);
    }
  }
  
  const overviewDeployments = await Deployment.find({ status: 'Active' }).lean();
  let overviewSum = 0;
  for (const d of overviewDeployments) {
    if (d.mobilisation) {
      const mob = await Mobilisation.findById(d.mobilisation).lean();
      overviewSum += (mob.profitPerHour || 0);
    }
  }
  
  console.log('Dashboard active deployments (count):', activeDeployments.length);
  console.log('Overview active deployments (count):', overviewDeployments.length);
  console.log('Dashboard Sum (naive sum of mob on active deployments):', dashboardSum);
  console.log('Overview Sum:', overviewSum);
  
  // Dashboard unique sum
  const mobIds = activeDeployments.map((d) => d.mobilisation).filter(Boolean);
  const activeMobs = await Mobilisation.find({ _id: { $in: mobIds } }).select('profitPerHour').lean();
  const dashboardUniqueSum = activeMobs.reduce((sum, mob) => sum + (mob.profitPerHour || 0), 0);
  console.log('Dashboard Unique Sum:', dashboardUniqueSum);

  process.exit(0);
}

run().catch(console.error);
