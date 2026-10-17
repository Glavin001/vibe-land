using UnrealBuildTool;

public class VibeLandCity : ModuleRules
{
	public VibeLandCity(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.NoPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "VibeLandNet" });
	}
}
