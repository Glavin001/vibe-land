using UnrealBuildTool;

public class VibeCity : ModuleRules
{
	public VibeCity(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.NoPCHs;
		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "VibeLandNet", "VibeLandCity" });
		PrivateDependencyModuleNames.AddRange(new string[] { "InputCore", "Slate", "SlateCore", "EnhancedInput" });
	}
}
