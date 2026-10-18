using UnrealBuildTool;

public class VibeLandNet : ModuleRules
{
	public VibeLandNet(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.NoPCHs;
		// The client core's header (frame record types) is part of this module's public API.
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "DeveloperSettings", "VibeClientCore" });
	}
}
