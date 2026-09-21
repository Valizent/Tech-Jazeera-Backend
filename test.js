import mongoose from 'mongoose';
import Deployment from './src/modules/deployments/deployment.model.js';
import Mobilisation from './src/modules/mobilisations/mobilisation.model.js';
import User from './src/modules/auth/user.model.js';

async function run() {
  await mongoose.connect('mongodb://127.0.0.1:27017/company-erp');
  
  const startOfThisMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const activeDeployments = await Deployment.find({
    startDate: { $lte: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59, 59, 999) },
    $or: [{ endDate: null }, { endDate: { $gte: startOfThisMonth } }]
  }).select('mobilisation worker').lean();
  
  console.log('Active deployments count:', activeDeployments.length);
  const mobIds = activeDeployments.map(d => d.mobilisation).filter(Boolean);
  
  const activeMobs = await Mobilisation.find({ _id: { $in: mobIds } }).select('profit coordinators worker workerName').lean();
  console.log('Active mobs with profit count:', activeMobs.length);
  
  const totalRev = activeMobs.reduce((sum, m) => sum + (m.profit?.monthly || 0), 0);
  console.log('Total global active revenue:', totalRev);
  
  const revByCoord = {};
  for (const m of activeMobs) {
    for (const c of m.coordinators || []) {
      revByCoord[c.user] = (revByCoord[c.user] || 0) + (m.profit?.monthly || 0);
    }
  }
  console.log('Revenue by coordinator:', revByCoord);
  
  const sarmad = await User.findOne({ name: /Sarmad/i });
  console.log('Sarmad ID:', sarmad?._id);
  
  process.exit(0);
}
run();
