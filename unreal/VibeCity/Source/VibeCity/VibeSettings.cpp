#include "VibeSettings.h"

#include "AudioDevice.h"
#include "Engine/Engine.h"
#include "Framework/Application/SlateApplication.h"
#include "Misc/ConfigCacheIni.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SSlider.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Text/STextBlock.h"
#include "Styling/AppStyle.h"

namespace
{
	const TCHAR* Section = TEXT("VibeCity.Settings");
	bool FreshSettings() { return FParse::Param(FCommandLine::Get(), TEXT("VibeFreshSettings")); }
	const TCHAR* ActionNames[] = {
		TEXT("MoveForward"), TEXT("MoveBackward"), TEXT("MoveLeft"), TEXT("MoveRight"), TEXT("Jump"), TEXT("Sprint"),
		TEXT("Crouch"), TEXT("Melee"), TEXT("Interact"), TEXT("Reset"), TEXT("Aim"), TEXT("Rifle"), TEXT("Cannon"),
		TEXT("Meteor"), TEXT("Aerial"),
	};
	static_assert(UE_ARRAY_COUNT(ActionNames) == static_cast<int32>(FVibeSettings::EAction::Count), "an ini name per action");
}

FVibeSettings::FVibeSettings()
{
	for (int32 i = 0; i < static_cast<int32>(EAction::Count); ++i)
	{
		Keys[i] = DefaultKey(static_cast<EAction>(i));
	}
}

FVibeSettings& FVibeSettings::Get()
{
	static FVibeSettings Settings = []
	{
		FVibeSettings S;
		S.Load();
		return S;
	}();
	return Settings;
}

FSimpleMulticastDelegate& FVibeSettings::OnChanged()
{
	static FSimpleMulticastDelegate Delegate;
	return Delegate;
}

const TCHAR* FVibeSettings::Label(EAction Action)
{
	// ControlsSettingsPanel.tsx keyboardRows (the ones /city uses), plus the weapon slots and the aerial camera.
	switch (Action)
	{
	case EAction::MoveForward: return TEXT("Move Forward");
	case EAction::MoveBackward: return TEXT("Move Backward");
	case EAction::MoveLeft: return TEXT("Move Left");
	case EAction::MoveRight: return TEXT("Move Right");
	case EAction::Jump: return TEXT("Jump / Vehicle Handbrake");
	case EAction::Sprint: return TEXT("Sprint");
	case EAction::Crouch: return TEXT("Crouch");
	case EAction::Melee: return TEXT("Melee");
	case EAction::Interact: return TEXT("Interact / Enter / Exit Vehicle");
	case EAction::Reset: return TEXT("Reset Vehicle / Reset City");
	case EAction::Aim: return TEXT("Aim / Scope Key");
	case EAction::Rifle: return TEXT("Rifle");
	case EAction::Cannon: return TEXT("Cannon");
	case EAction::Meteor: return TEXT("Meteor strike");
	case EAction::Aerial: return TEXT("Aerial camera");
	default: return TEXT("?");
	}
}

FKey FVibeSettings::DefaultKey(EAction Action)
{
	// input/bindings.ts DEFAULT_BINDINGS.keyboard.
	switch (Action)
	{
	case EAction::MoveForward: return EKeys::W;
	case EAction::MoveBackward: return EKeys::S;
	case EAction::MoveLeft: return EKeys::A;
	case EAction::MoveRight: return EKeys::D;
	case EAction::Jump: return EKeys::SpaceBar;
	case EAction::Sprint: return EKeys::LeftShift;
	case EAction::Crouch: return EKeys::C;
	case EAction::Melee: return EKeys::V;
	case EAction::Interact: return EKeys::E;
	case EAction::Reset: return EKeys::R;
	case EAction::Aim: return EKeys::LeftAlt;
	case EAction::Rifle: return EKeys::One;
	case EAction::Cannon: return EKeys::Two;
	case EAction::Meteor: return EKeys::Three;
	case EAction::Aerial: return EKeys::N;
	default: return EKeys::Invalid;
	}
}

void FVibeSettings::Load()
{
	if (FreshSettings() || !GConfig)
	{
		return;
	}
	auto Float = [](const TCHAR* Name, float& Value)
	{
		GConfig->GetFloat(Section, Name, Value, GGameUserSettingsIni);
	};
	Float(TEXT("MouseSensitivity"), MouseSensitivity);
	Float(TEXT("MouseYOverX"), MouseYOverX);
	GConfig->GetBool(Section, TEXT("MouseInvertY"), bMouseInvertY, GGameUserSettingsIni);
	Float(TEXT("GamepadYawSpeed"), GamepadYawSpeed);
	Float(TEXT("GamepadYOverX"), GamepadYOverX);
	Float(TEXT("GamepadCurveExponent"), GamepadCurveExponent);
	Float(TEXT("GamepadAimDeadzone"), GamepadAimDeadzone);
	GConfig->GetBool(Section, TEXT("GamepadInvertY"), bGamepadInvertY, GGameUserSettingsIni);
	GConfig->GetBool(Section, TEXT("SoundEnabled"), bSoundEnabled, GGameUserSettingsIni);
	Float(TEXT("MasterVolume"), MasterVolume);
	int32 Preset = static_cast<int32>(MixPreset), Range = static_cast<int32>(DynamicRange);
	GConfig->GetInt(Section, TEXT("MixPreset"), Preset, GGameUserSettingsIni);
	GConfig->GetInt(Section, TEXT("DynamicRange"), Range, GGameUserSettingsIni);
	MixPreset = static_cast<uint32>(FMath::Clamp(Preset, 0, 2));
	DynamicRange = static_cast<uint32>(FMath::Clamp(Range, 0, 2));
	for (int32 i = 0; i < static_cast<int32>(EAction::Count); ++i)
	{
		FString Name;
		if (GConfig->GetString(Section, *FString::Printf(TEXT("Key.%s"), ActionNames[i]), Name, GGameUserSettingsIni))
		{
			const FKey Saved(*Name);
			if (Saved.IsValid())
			{
				Keys[i] = Saved;
			}
		}
	}
}

void FVibeSettings::Save() const
{
	if (FreshSettings() || !GConfig)
	{
		return;
	}
	GConfig->SetFloat(Section, TEXT("MouseSensitivity"), MouseSensitivity, GGameUserSettingsIni);
	GConfig->SetFloat(Section, TEXT("MouseYOverX"), MouseYOverX, GGameUserSettingsIni);
	GConfig->SetBool(Section, TEXT("MouseInvertY"), bMouseInvertY, GGameUserSettingsIni);
	GConfig->SetFloat(Section, TEXT("GamepadYawSpeed"), GamepadYawSpeed, GGameUserSettingsIni);
	GConfig->SetFloat(Section, TEXT("GamepadYOverX"), GamepadYOverX, GGameUserSettingsIni);
	GConfig->SetFloat(Section, TEXT("GamepadCurveExponent"), GamepadCurveExponent, GGameUserSettingsIni);
	GConfig->SetFloat(Section, TEXT("GamepadAimDeadzone"), GamepadAimDeadzone, GGameUserSettingsIni);
	GConfig->SetBool(Section, TEXT("GamepadInvertY"), bGamepadInvertY, GGameUserSettingsIni);
	GConfig->SetBool(Section, TEXT("SoundEnabled"), bSoundEnabled, GGameUserSettingsIni);
	GConfig->SetFloat(Section, TEXT("MasterVolume"), MasterVolume, GGameUserSettingsIni);
	GConfig->SetInt(Section, TEXT("MixPreset"), static_cast<int32>(MixPreset), GGameUserSettingsIni);
	GConfig->SetInt(Section, TEXT("DynamicRange"), static_cast<int32>(DynamicRange), GGameUserSettingsIni);
	for (int32 i = 0; i < static_cast<int32>(EAction::Count); ++i)
	{
		GConfig->SetString(Section, *FString::Printf(TEXT("Key.%s"), ActionNames[i]), *Keys[i].ToString(), GGameUserSettingsIni);
	}
	GConfig->Flush(false, GGameUserSettingsIni);
}

void FVibeSettings::Changed()
{
	// INPUT_SETTINGS_LIMITS.
	MouseSensitivity = FMath::Clamp(MouseSensitivity, 0.0005f, 0.01f);
	MouseYOverX = FMath::Clamp(MouseYOverX, 0.4f, 1.6f);
	GamepadYawSpeed = FMath::Clamp(GamepadYawSpeed, 1.0f, 5.5f);
	GamepadYOverX = FMath::Clamp(GamepadYOverX, 0.4f, 1.3f);
	GamepadCurveExponent = FMath::Clamp(GamepadCurveExponent, 1.0f, 3.0f);
	GamepadAimDeadzone = FMath::Clamp(GamepadAimDeadzone, 0.03f, 0.25f);
	MasterVolume = FMath::Clamp(MasterVolume, 0.0f, 1.0f);
	MixPreset = FMath::Min(MixPreset, 2u);
	DynamicRange = FMath::Min(DynamicRange, 2u);
	Save();
	ApplySound();
	OnChanged().Broadcast();
}

void FVibeSettings::ApplySound() const
{
	if (GEngine)
	{
		if (FAudioDeviceHandle Device = GEngine->GetMainAudioDevice())
		{
			Device->SetTransientPrimaryVolume(bSoundEnabled ? MasterVolume : 0.0f);
		}
	}
}

namespace
{
	/** The next key or mouse button pressed becomes the binding of the action awaiting one. */
	class SVibeKeyCapture : public SCompoundWidget
	{
	public:
		SLATE_BEGIN_ARGS(SVibeKeyCapture) {}
			SLATE_EVENT(FSimpleDelegate, OnBound)
		SLATE_END_ARGS()

		void Construct(const FArguments& Args, FVibeSettings::EAction InAction)
		{
			Action = InAction;
			OnBound = Args._OnBound;
			ChildSlot
			[
				SNew(SButton)
				.OnClicked_Lambda([this]()
				{
					bAwaiting = true;
					FSlateApplication::Get().SetKeyboardFocus(SharedThis(this));
					return FReply::Handled();
				})
				[
					SNew(STextBlock).Text_Lambda([this]()
					{
						return bAwaiting ? FText::FromString(TEXT("Press a key…"))
							: FVibeSettings::Get().Key(Action).GetDisplayName();
					})
				]
			];
		}

		virtual bool SupportsKeyboardFocus() const override { return true; }

		virtual FReply OnKeyDown(const FGeometry&, const FKeyEvent& Event) override
		{
			return Bind(Event.GetKey());
		}

		virtual FReply OnMouseButtonDown(const FGeometry& Geometry, const FPointerEvent& Event) override
		{
			return bAwaiting ? Bind(Event.GetEffectingButton()) : SCompoundWidget::OnMouseButtonDown(Geometry, Event);
		}

		virtual void OnFocusLost(const FFocusEvent&) override { bAwaiting = false; }

	private:
		FReply Bind(const FKey& Key)
		{
			if (!bAwaiting)
			{
				return FReply::Unhandled();
			}
			bAwaiting = false;
			if (Key != EKeys::Escape)
			{
				FVibeSettings& S = FVibeSettings::Get();
				S.Keys[static_cast<int32>(Action)] = Key;
				S.Changed();
				OnBound.ExecuteIfBound();
			}
			return FReply::Handled();
		}

		FVibeSettings::EAction Action = FVibeSettings::EAction::Jump;
		bool bAwaiting = false;
		FSimpleDelegate OnBound;
	};

	/** Sound and Controls, as the web's AudioSettingsPanel and ControlsSettingsPanel. */
	class SVibeSettingsPanel : public SCompoundWidget
	{
	public:
		SLATE_BEGIN_ARGS(SVibeSettingsPanel) {}
		SLATE_END_ARGS()

		void Construct(const FArguments&)
		{
			ChildSlot
			.HAlign(HAlign_Right)
			.VAlign(VAlign_Top)
			.Padding(12.0f, 56.0f)
			[
				SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Right)
				[
					SNew(SHorizontalBox)
					+ SHorizontalBox::Slot().AutoWidth().Padding(4.0f, 0.0f)[ TabButton(TEXT("Sound"), ETab::Sound) ]
					+ SHorizontalBox::Slot().AutoWidth().Padding(4.0f, 0.0f)[ TabButton(TEXT("Controls"), ETab::Controls) ]
				]
				+ SVerticalBox::Slot().AutoHeight().Padding(0.0f, 8.0f)
				[
					SAssignNew(Body, SBox).WidthOverride(360.0f).Visibility(EVisibility::Collapsed)
				]
			];
		}

	private:
		enum class ETab : uint8 { None, Sound, Controls };

		TSharedRef<SWidget> TabButton(const TCHAR* Name, ETab Which)
		{
			return SNew(SButton)
				.OnClicked_Lambda([this, Which]()
				{
					Show(Tab == Which ? ETab::None : Which);
					return FReply::Handled();
				})
				[ SNew(STextBlock).Text(FText::FromString(Name)) ];
		}

		void Show(ETab Which)
		{
			Tab = Which;
			Body->SetVisibility(Which == ETab::None ? EVisibility::Collapsed : EVisibility::Visible);
			Body->SetContent(Which == ETab::Sound ? SoundPanel() : Which == ETab::Controls ? ControlsPanel() : SNullWidget::NullWidget);
		}

		static TSharedRef<SWidget> Card(TSharedRef<SWidget> Content)
		{
			return SNew(SBorder)
				.Padding(12.0f)
				.BorderBackgroundColor(FLinearColor(0.02f, 0.03f, 0.06f, 0.9f))
				[ Content ];
		}

		static TSharedRef<SWidget> Slider(const TCHAR* Label, float Min, float Max, TFunction<float&()> Value, TFunction<FString(float)> Show)
		{
			return SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight()
				[
					SNew(STextBlock).Text_Lambda([Label, Value, Show]() { return FText::FromString(FString::Printf(TEXT("%s  %s"), Label, *Show(Value()))); })
				]
				+ SVerticalBox::Slot().AutoHeight().Padding(0.0f, 2.0f, 0.0f, 8.0f)
				[
					SNew(SSlider)
					.MinValue(Min).MaxValue(Max)
					.Value_Lambda([Value]() { return Value(); })
					.OnValueChanged_Lambda([Value](float V) { Value() = V; FVibeSettings::Get().Changed(); })
				];
		}

		static TSharedRef<SWidget> Toggle(const TCHAR* Label, TFunction<bool&()> Value)
		{
			return SNew(SCheckBox)
				.IsChecked_Lambda([Value]() { return Value() ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
				.OnCheckStateChanged_Lambda([Value](ECheckBoxState State) { Value() = State == ECheckBoxState::Checked; FVibeSettings::Get().Changed(); })
				[ SNew(STextBlock).Text(FText::FromString(Label)) ];
		}

		/** A row of choices (the web's preset buttons and dynamic-range select). */
		static TSharedRef<SWidget> Choice(const TCHAR* Label, TArray<FString> Names, TFunction<uint32&()> Value)
		{
			TSharedRef<SHorizontalBox> Row = SNew(SHorizontalBox);
			for (int32 i = 0; i < Names.Num(); ++i)
			{
				Row->AddSlot().AutoWidth().Padding(0.0f, 0.0f, 4.0f, 0.0f)
				[
					SNew(SCheckBox)
					.Style(&FAppStyle::Get().GetWidgetStyle<FCheckBoxStyle>("ToggleButtonCheckbox"))
					.IsChecked_Lambda([Value, i]() { return Value() == static_cast<uint32>(i) ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
					.OnCheckStateChanged_Lambda([Value, i](ECheckBoxState) { Value() = static_cast<uint32>(i); FVibeSettings::Get().Changed(); })
					[ SNew(STextBlock).Margin(FMargin(6.0f, 2.0f)).Text(FText::FromString(Names[i])) ]
				];
			}
			return SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight()[ SNew(STextBlock).Text(FText::FromString(Label)) ]
				+ SVerticalBox::Slot().AutoHeight().Padding(0.0f, 2.0f, 0.0f, 8.0f)[ Row ];
		}

		TSharedRef<SWidget> SoundPanel()
		{
			return Card(SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight()[ SNew(STextBlock).Text(FText::FromString(TEXT("Sound settings"))) ]
				+ SVerticalBox::Slot().AutoHeight().Padding(0.0f, 8.0f)[ Toggle(TEXT("Game sound"), []() -> bool& { return FVibeSettings::Get().bSoundEnabled; }) ]
				+ SVerticalBox::Slot().AutoHeight()[ Slider(TEXT("Master volume"), 0.0f, 1.0f,
					[]() -> float& { return FVibeSettings::Get().MasterVolume; },
					[](float V) { return FString::Printf(TEXT("%d%%"), FMath::RoundToInt(V * 100.0f)); }) ]
				// settings.ts MIX_LABELS and the dynamic-range select.
				+ SVerticalBox::Slot().AutoHeight()[ Choice(TEXT("Mix character"), { TEXT("Cinematic"), TEXT("Natural"), TEXT("Clarity") },
					[]() -> uint32& { return FVibeSettings::Get().MixPreset; }) ]
				+ SVerticalBox::Slot().AutoHeight()[ Choice(TEXT("Dynamic range"), { TEXT("Balanced"), TEXT("Night"), TEXT("Cinematic") },
					[]() -> uint32& { return FVibeSettings::Get().DynamicRange; }) ]);
		}

		TSharedRef<SWidget> ControlsPanel()
		{
			TSharedRef<SVerticalBox> Keys = SNew(SVerticalBox);
			for (int32 i = 0; i < static_cast<int32>(FVibeSettings::EAction::Count); ++i)
			{
				const FVibeSettings::EAction Action = static_cast<FVibeSettings::EAction>(i);
				Keys->AddSlot().AutoHeight().Padding(0.0f, 1.0f)
				[
					SNew(SHorizontalBox)
					+ SHorizontalBox::Slot().FillWidth(1.0f).VAlign(VAlign_Center)[ SNew(STextBlock).Text(FText::FromString(FVibeSettings::Label(Action))) ]
					+ SHorizontalBox::Slot().AutoWidth()[ SNew(SBox).WidthOverride(130.0f)[ SNew(SVibeKeyCapture, Action) ] ]
				];
			}
			const auto Sens = [](float V) { return FString::Printf(TEXT("%.4f"), V); };
			const auto Ratio = [](float V) { return FString::Printf(TEXT("%.2f"), V); };
			return Card(SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight()[ SNew(STextBlock).Text(FText::FromString(TEXT("Mouse"))) ]
				+ SVerticalBox::Slot().AutoHeight()[ Slider(TEXT("Sensitivity"), 0.0005f, 0.01f, []() -> float& { return FVibeSettings::Get().MouseSensitivity; }, Sens) ]
				+ SVerticalBox::Slot().AutoHeight()[ Slider(TEXT("Vertical / horizontal"), 0.4f, 1.6f, []() -> float& { return FVibeSettings::Get().MouseYOverX; }, Ratio) ]
				+ SVerticalBox::Slot().AutoHeight()[ Toggle(TEXT("Invert vertical look"), []() -> bool& { return FVibeSettings::Get().bMouseInvertY; }) ]
				+ SVerticalBox::Slot().AutoHeight().Padding(0.0f, 10.0f, 0.0f, 0.0f)[ SNew(STextBlock).Text(FText::FromString(TEXT("Gamepad"))) ]
				+ SVerticalBox::Slot().AutoHeight()[ Slider(TEXT("Look speed (rad/s)"), 1.0f, 5.5f, []() -> float& { return FVibeSettings::Get().GamepadYawSpeed; }, Ratio) ]
				+ SVerticalBox::Slot().AutoHeight()[ Slider(TEXT("Vertical / horizontal"), 0.4f, 1.3f, []() -> float& { return FVibeSettings::Get().GamepadYOverX; }, Ratio) ]
				+ SVerticalBox::Slot().AutoHeight()[ Slider(TEXT("Response curve"), 1.0f, 3.0f, []() -> float& { return FVibeSettings::Get().GamepadCurveExponent; }, Ratio) ]
				+ SVerticalBox::Slot().AutoHeight()[ Slider(TEXT("Look deadzone"), 0.03f, 0.25f, []() -> float& { return FVibeSettings::Get().GamepadAimDeadzone; }, Ratio) ]
				+ SVerticalBox::Slot().AutoHeight()[ Toggle(TEXT("Invert vertical look"), []() -> bool& { return FVibeSettings::Get().bGamepadInvertY; }) ]
				+ SVerticalBox::Slot().AutoHeight().Padding(0.0f, 10.0f, 0.0f, 4.0f)[ SNew(STextBlock).Text(FText::FromString(TEXT("Keyboard (click, then press a key; Esc cancels)"))) ]
				+ SVerticalBox::Slot().AutoHeight()[ Keys ]
				+ SVerticalBox::Slot().AutoHeight().Padding(0.0f, 8.0f, 0.0f, 0.0f)
				[
					SNew(SButton)
					.OnClicked_Lambda([this]()
					{
						FVibeSettings& S = FVibeSettings::Get();
						const FVibeSettings Defaults;
						for (int32 i = 0; i < static_cast<int32>(FVibeSettings::EAction::Count); ++i)
						{
							S.Keys[i] = Defaults.Keys[i];
						}
						S.Changed();
						return FReply::Handled();
					})
					[ SNew(STextBlock).Text(FText::FromString(TEXT("Reset keys to defaults"))) ]
				]);
		}

		TSharedPtr<SBox> Body;
		ETab Tab = ETab::None;
	};
}

TSharedRef<SWidget> FVibeSettings::MakePanel()
{
	return SNew(SVibeSettingsPanel);
}
