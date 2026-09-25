import { validateVehicleAssembly, preparationIssue } from './validation.mjs';
self.onmessage = async ({data}) => {
  try {
    await validateVehicleAssembly(data.configuration);
    self.postMessage({key: data.key, complete: true, issue: null});
  } catch (error) {
    self.postMessage({key: data.key, complete: true, issue: preparationIssue(error, data.configuration)});
  }
};
