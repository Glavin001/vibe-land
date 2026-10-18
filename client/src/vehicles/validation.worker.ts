import { validateVehicleAssembly, preparationIssue } from './validation.mjs';
self.onmessage = async ({data}) => {
  try {
    const {collision} = await validateVehicleAssembly(data.configuration);
    // Reuse the finalized server recipe, including aliases created by clipping.
    const explosionGroups = collision.parts.map((part: {visualIds: string[]; position: number[]}) =>
      ({visualIds: part.visualIds, position: part.position}));
    self.postMessage({key: data.key, complete: true, issue: null, explosionGroups});
  } catch (error) {
    self.postMessage({key: data.key, complete: true, issue: preparationIssue(error, data.configuration)});
  }
};
