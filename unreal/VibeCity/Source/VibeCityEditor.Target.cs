using UnrealBuildTool;

public class VibeCityEditorTarget : TargetRules
{
	public VibeCityEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.V7;
		IncludeOrderVersion = EngineIncludeOrderVersion.Unreal5_8;
		ExtraModuleNames.Add("VibeCity");
		VibeCityMacToolchain.Apply(this, Target);
	}
}
