#include "VibeCityBatteries.h"

#include "Components/PointLightComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "UObject/ConstructorHelpers.h"
#include "VibeNetSubsystem.h"

namespace
{
	// netEntityRenderers.ts: a full battery holds 1000 energy.
	constexpr float BatteryMaxEnergy = 1000.0f;
}

AVibeCityBatteries::AVibeCityBatteries()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	static ConstructorHelpers::FObjectFinderOptional<UStaticMesh> Mesh(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	Cylinder = Mesh.Get();
	static ConstructorHelpers::FObjectFinderOptional<UMaterialInterface> Material(TEXT("/Game/VibeCity/Materials/M_VibeCityBattery.M_VibeCityBattery"));
	CellMaterial = Material.Get();
}

void AVibeCityBatteries::BeginPlay()
{
	Super::BeginPlay();
	const UGameInstance* GameInstance = GetGameInstance();
	if (UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
	{
		FrameHandle = Net->OnFrame.AddUObject(this, &AVibeCityBatteries::OnFrame);
	}
}

void AVibeCityBatteries::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	const UGameInstance* GameInstance = GetGameInstance();
	if (UVibeNetSubsystem* Net = GameInstance ? GameInstance->GetSubsystem<UVibeNetSubsystem>() : nullptr)
	{
		Net->OnFrame.Remove(FrameHandle);
	}
	Super::EndPlay(EndPlayReason);
}

void AVibeCityBatteries::OnFrame(const VlFrameView& Frame)
{
	if (!Cylinder)
	{
		return;
	}
	TSet<uint32> Seen;
	for (size_t i = 0; i < Frame.battery_count; ++i)
	{
		const VlBattery& B = Frame.batteries[i];
		Seen.Add(B.id);
		FCell* Cell = Cells.Find(B.id);
		if (!Cell)
		{
			Cell = &Cells.Add(B.id);
			UStaticMeshComponent* Body = NewObject<UStaticMeshComponent>(this);
			Body->SetStaticMesh(Cylinder);
			Body->SetCollisionEnabled(ECollisionEnabled::NoCollision);
			Body->SetupAttachment(RootComponent);
			Body->RegisterComponent();
			if (CellMaterial)
			{
				Cell->Material = UMaterialInstanceDynamic::Create(CellMaterial, this);
				Body->SetMaterial(0, Cell->Material);
			}
			UPointLightComponent* Light = NewObject<UPointLightComponent>(this);
			Light->SetupAttachment(Body);
			Light->SetLightColor(FLinearColor(1.0f, 0.8f, 0.2f));
			Light->SetCastShadows(false);
			Light->RegisterComponent();
			Cell->Body = Body;
			Cell->Light = Light;
			Cell->Phase = (B.id % 997) * 0.37f;
			Owned.Add(Body);
			Owned.Add(Light);
		}
		// netEntityRenderers.ts: radius 0.12-0.37 m and height 0.14-0.36 m with energy, sat on
		// the ground beneath the battery's centre (the cylinder mesh is 1 m tall, 1 m across).
		Cell->Energy = FMath::Min(B.energy / BatteryMaxEnergy, 1.0f);
		const float Radius = 12.0f + Cell->Energy * 25.0f;
		const float Height = 14.0f + Cell->Energy * 22.0f;
		const FVector Base(B.pos[0], B.pos[1], B.pos[2] - B.height * 0.5f);
		Cell->Body->SetWorldLocation(Base + FVector::UpVector * (Height * 0.5f));
		Cell->Body->SetWorldScale3D(FVector(Radius / 50.0f, Radius / 50.0f, Height / 100.0f));
		Cell->Light->SetAttenuationRadius(250.0f + Cell->Energy * 350.0f);
	}
	for (auto It = Cells.CreateIterator(); It; ++It)
	{
		if (!Seen.Contains(It.Key()))
		{
			Owned.Remove(It.Value().Light);
			Owned.Remove(It.Value().Body);
			It.Value().Light->DestroyComponent();
			It.Value().Body->DestroyComponent();
			It.RemoveCurrent();
		}
	}
}

void AVibeCityBatteries::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	Time += DeltaSeconds;
	for (TPair<uint32, FCell>& Pair : Cells)
	{
		FCell& Cell = Pair.Value;
		// netEntityRenderers.ts: glow 1.2-4.2 with energy, pulsing.
		const float Pulse = 0.75f + 0.25f * FMath::Sin(Time * 3.0f + Cell.Phase);
		const float Glow = (1.2f + Cell.Energy * 3.0f) * Pulse;
		if (Cell.Material)
		{
			Cell.Material->SetScalarParameterValue(TEXT("Glow"), Glow);
		}
		// Candelas: a few tens, a warm pool on the ground at night-time brightness, not a lamp.
		Cell.Light->SetIntensity(Glow * 15.0f);
	}
}
