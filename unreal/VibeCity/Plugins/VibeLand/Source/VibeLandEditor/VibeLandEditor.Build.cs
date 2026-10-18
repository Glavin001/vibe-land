using UnrealBuildTool;

public class VibeLandEditor : ModuleRules
{
	public VibeLandEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.NoPCHs;
		PrivateDependencyModuleNames.AddRange(new string[] {
			"Core", "CoreUObject", "Engine", "UnrealEd", "AssetRegistry", "MeshDescription", "StaticMeshDescription",
			"ProceduralMeshComponent", "VibeClientCore", "VibeLandNet", "VibeLandCity" });
	}
}
