// The city's chunks as the client core's meshes: standing chunks merged per cell, each live dynamic
// body its own mesh. See AVibeCityDirector.

#include "VibeCityDirector.h"

#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "VibeCityBatteries.h"
#include "VibeCityGrass.h"

#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "ProceduralMeshComponent.h"
#include "VibeLandNet.h"
#include "VibeNetSubsystem.h"
#include "vibe_client_core.h"

namespace
{
	FVector ToVector(const float (&V)[3]) { return FVector(V[0], V[1], V[2]); }
	FQuat ToQuat(const float (&Q)[4]) { return FQuat(Q[0], Q[1], Q[2], Q[3]).GetNormalized(); }
}

UProceduralMeshComponent* AVibeCityDirector::NewChunkComponent()
{
	UProceduralMeshComponent* Component = NewObject<UProceduralMeshComponent>(this);
	Component->SetMobility(EComponentMobility::Movable);
	Component->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Component->bUseAsyncCooking = false;
	Component->SetCastShadow(true);
	Component->SetupAttachment(RootComponent);
	Component->RegisterComponent();
	return Component;
}

void AVibeCityDirector::BuildCity(UVibeNetSubsystem* NetSubsystem)
{
	const TArrayView<const VlChunk> Chunks = NetSubsystem->Chunks();
	VlMeshView Meshes = {};
	if (Chunks.Num() == 0 || !NetSubsystem->ChunkMeshes(Meshes) || Meshes.range_count != static_cast<size_t>(Chunks.Num()))
	{
		return;
	}
	const double Started = FPlatformTime::Seconds();

	// The catalog: per entry, the layer and metalness the chunk material reads from UV1.
	Catalog = VibeCityCells::FCatalogMap::Build(bHdMaterial);
	if (!ChunkMaterial)
	{
		UE_LOG(LogVibeLand, Warning, TEXT("M_VibeCityChunk is missing: run scripts/unreal/import-city-materials.sh. Chunks use the basic shape material."));
	}

	TMap<FIntPoint, int32> CellByKey;
	Slots.SetNum(Chunks.Num());
	for (int32 Index = 0; Index < Chunks.Num(); ++Index)
	{
		const VlChunk& Chunk = Chunks[Index];
		FChunkSlot& Slot = Slots[Index];
		Slot.Rest = VibeCityCells::RestTransform(Chunk);
		const FVector P = Slot.Rest.GetLocation();
		const FIntPoint Key = VibeCityCells::CellKey(P);
		int32* Existing = CellByKey.Find(Key);
		Slot.Cell = Existing ? *Existing : CellByKey.Add(Key, CellChunks.Num());
		if (!Existing)
		{
			CellChunks.AddDefaulted();
			CellKeys.Add(Key);
			CellComponents.Add(NewChunkComponent());
		}
		CellChunks[Slot.Cell].Add(Index);
		Bounds += P;
	}
	// The imported city for this manifest (and material mode), when there is one: -VibeRuntimeCells
	// draws every cell from its runtime mesh instead.
	ImportedOpaque.SetNum(CellChunks.Num());
	ImportedGlass.SetNum(CellChunks.Num());
	const FString Hash = NetSubsystem->ManifestHash();
	const FString Folder = Hash.IsEmpty() || FParse::Param(FCommandLine::Get(), TEXT("VibeRuntimeCells")) ? FString() : VibeCityCells::SceneFolder(Hash, bHdMaterial);
	ImportedFolder = Folder;
	for (int32 Cell = 0; Cell < CellChunks.Num(); ++Cell)
	{
		RebuildCell(Cell);
	}
	const int32 Imported = ImportedCellsDrawn();
	if (Imported == 0)
	{
		ImportedFolder.Reset(); // none for this manifest: rebuilt cells need not look
	}
	if (!Folder.IsEmpty())
	{
		UE_LOG(LogVibeLand, Display, TEXT("imported city %s: %d of %d cells%s"), *Folder, Imported, CellChunks.Num(),
			Imported == 0 ? TEXT(" (none imported for this manifest: scripts/unreal/import-city.sh)") : TEXT(""));
	}
	bCityBuilt = true;
	// The energy batteries dropped where players die (the web's BatteriesRenderer).
	if (!Batteries)
	{
		Batteries = GetWorld()->SpawnActor<AVibeCityBatteries>();
	}
	// The web's meadow over the ground (?grass=off there; -VibeNoGrass here).
	if (!FParse::Param(FCommandLine::Get(), TEXT("VibeNoGrass")))
	{
		if (AVibeCityGrass* Grass = GetWorld()->SpawnActor<AVibeCityGrass>())
		{
			Grass->SetExclusions(NetSubsystem->GrassExclusions());
			// GrassLayoutSync.ts grassLayoutUrl: the match's shared painted grass, from the game
			// server unless -VibeGrassUrl= names another (the web's GRASS_SERVER_PORT service).
			FString GrassUrl = NetSubsystem->CurrentApiBaseUrl() / TEXT("match-stats") / FGenericPlatformHttp::UrlEncode(NetSubsystem->CurrentMatchId()) / TEXT("grass");
			FParse::Value(FCommandLine::Get(), TEXT("VibeGrassUrl="), GrassUrl);
			Grass->SetLayoutUrl(GrassUrl);
		}
	}
	UE_LOG(LogVibeLand, Display, TEXT("city built: %d chunks (%llu vertices) in %d cells, %.1f ms; bounds %s"),
		Chunks.Num(), static_cast<unsigned long long>(Meshes.vertex_count), CellChunks.Num(),
		(FPlatformTime::Seconds() - Started) * 1000.0, *Bounds.ToString());
	OnCityBuilt.Broadcast(Bounds);
}

void AVibeCityDirector::AppendChunk(int32 ChunkIndex, const FTransform& ToComponent, VibeCityCells::FSection& Opaque, VibeCityCells::FSection& Glass) const
{
	UVibeNetSubsystem* NetSubsystem = Net();
	VlMeshView M = {};
	if (NetSubsystem && NetSubsystem->ChunkMeshes(M))
	{
		VibeCityCells::AppendChunk(M, ChunkIndex, ToComponent, Catalog, Opaque, Glass);
	}
}

bool AVibeCityDirector::UseImportedCell(int32 Cell, const FString& Folder)
{
	const FString Name = VibeCityCells::CellAssetName(CellKeys[Cell], false);
	UStaticMesh* Opaque = LoadObject<UStaticMesh>(nullptr, *(Folder / Name + TEXT(".") + Name), nullptr, LOAD_NoWarn | LOAD_Quiet);
	if (!Opaque)
	{
		return false;
	}
	auto Make = [this](UStaticMesh* Mesh, UMaterialInterface* Material)
	{
		UStaticMeshComponent* C = NewObject<UStaticMeshComponent>(this);
		C->SetStaticMesh(Mesh);
		C->SetMobility(EComponentMobility::Movable);
		C->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		C->SetCastShadow(true);
		C->SetMaterial(0, Material);
		C->SetupAttachment(RootComponent);
		C->RegisterComponent();
		return C;
	};
	ImportedOpaque[Cell] = Make(Opaque, ChunkMaterial ? ChunkMaterial.Get() : BaseMaterial.Get());
	const FString GlassName = VibeCityCells::CellAssetName(CellKeys[Cell], true);
	if (UStaticMesh* Glass = LoadObject<UStaticMesh>(nullptr, *(Folder / GlassName + TEXT(".") + GlassName), nullptr, LOAD_NoWarn | LOAD_Quiet))
	{
		ImportedGlass[Cell] = Make(Glass, GlassMaterial ? GlassMaterial.Get() : BaseMaterial.Get());
	}
	return true;
}

void AVibeCityDirector::DropImportedCell(int32 Cell)
{
	for (TArray<TObjectPtr<UStaticMeshComponent>>* Set : { &ImportedOpaque, &ImportedGlass })
	{
		if (Set->IsValidIndex(Cell) && (*Set)[Cell])
		{
			(*Set)[Cell]->DestroyComponent();
			(*Set)[Cell] = nullptr;
		}
	}
}

int32 AVibeCityDirector::ImportedCellsDrawn() const
{
	int32 N = 0;
	for (const TObjectPtr<UStaticMeshComponent>& C : ImportedOpaque)
	{
		N += C ? 1 : 0;
	}
	return N;
}

const UStaticMesh* AVibeCityDirector::ImportedCellMesh(int32 Cell) const
{
	return ImportedOpaque.IsValidIndex(Cell) && ImportedOpaque[Cell] ? ImportedOpaque[Cell]->GetStaticMesh() : nullptr;
}

int64 AVibeCityDirector::CellTriangles(int32 Cell, bool bGlass) const
{
	if (!CellChunks.IsValidIndex(Cell))
	{
		return 0;
	}
	VibeCityCells::FSection Opaque, Glass;
	for (const int32 ChunkIndex : CellChunks[Cell])
	{
		const FChunkSlot& Slot = Slots[ChunkIndex];
		if (Slot.Body == 0 && !Slot.bRemoved)
		{
			AppendChunk(ChunkIndex, Slot.Rest, Opaque, Glass);
		}
	}
	return (bGlass ? Glass : Opaque).Triangles.Num() / 3;
}

void AVibeCityDirector::ApplySections(UProceduralMeshComponent* Component, VibeCityCells::FSection& Opaque, VibeCityCells::FSection& Glass) const
{
	static const TArray<FVector2D> NoUV;
	static const TArray<FColor> NoColor;
	Component->ClearAllMeshSections();
	if (Opaque.Vertices.Num() > 0)
	{
		Component->CreateMeshSection(0, Opaque.Vertices, Opaque.Triangles, Opaque.Normals, Opaque.UV0, Opaque.UV1, NoUV, NoUV, NoColor, Opaque.Tangents, /*bCreateCollision=*/false);
		Component->SetMaterial(0, ChunkMaterial ? ChunkMaterial.Get() : BaseMaterial.Get());
	}
	if (Glass.Vertices.Num() > 0)
	{
		Component->CreateMeshSection(1, Glass.Vertices, Glass.Triangles, Glass.Normals, Glass.UV0, Glass.UV1, NoUV, NoUV, NoColor, Glass.Tangents, /*bCreateCollision=*/false);
		Component->SetMaterial(1, GlassMaterial ? GlassMaterial.Get() : BaseMaterial.Get());
	}
}

void AVibeCityDirector::RebuildCell(int32 Cell)
{
	// Intact (every chunk standing, none removed, as after a city reset), a cell draws its imported
	// mesh when there is one; from its first change, its runtime mesh.
	bool bIntact = true;
	for (const int32 ChunkIndex : CellChunks[Cell])
	{
		bIntact &= Slots[ChunkIndex].Body == 0 && !Slots[ChunkIndex].bRemoved;
	}
	if (bIntact && !ImportedFolder.IsEmpty() && (ImportedOpaque[Cell] || UseImportedCell(Cell, ImportedFolder)))
	{
		CellComponents[Cell]->ClearAllMeshSections();
		return;
	}
	DropImportedCell(Cell);
	VibeCityCells::FSection Opaque, Glass;
	for (const int32 ChunkIndex : CellChunks[Cell])
	{
		const FChunkSlot& Slot = Slots[ChunkIndex];
		if (Slot.Body == 0 && !Slot.bRemoved)
		{
			// Cells sit at the world origin: a standing chunk's vertex is rest_pos + rest_quat * v.
			AppendChunk(ChunkIndex, Slot.Rest, Opaque, Glass);
		}
	}
	ApplySections(CellComponents[Cell], Opaque, Glass);
}

void AVibeCityDirector::RebuildBody(uint64 Body)
{
	const TArray<int32>* Members = BodyChunks.Find(Body);
	TObjectPtr<UProceduralMeshComponent>* Existing = BodyComponents.Find(Body);
	if (!Members || Members->Num() == 0)
	{
		if (Existing && *Existing)
		{
			(*Existing)->DestroyComponent();
		}
		BodyComponents.Remove(Body);
		return;
	}
	UProceduralMeshComponent* Component = Existing ? Existing->Get() : nullptr;
	if (!Component)
	{
		Component = NewChunkComponent();
		BodyComponents.Add(Body, Component);
	}
	// In the body's frame: a chunk on a body keeps the body's rotation, so its vertex is
	// local_pos + v there, and the component carries the body's pose.
	VibeCityCells::FSection Opaque, Glass;
	for (const int32 ChunkIndex : *Members)
	{
		AppendChunk(ChunkIndex, FTransform(Slots[ChunkIndex].Local), Opaque, Glass);
	}
	ApplySections(Component, Opaque, Glass);
	if (const FTransform* Pose = BodyPoses.Find(Body))
	{
		Component->SetWorldTransform(*Pose);
		Component->SetVisibility(true);
	}
	else
	{
		Component->SetVisibility(false); // until its first pose
	}
}

void AVibeCityDirector::ApplyFrame(const VlFrameView& Frame)
{
	// Assignment changes first: which body each chunk now rides.
	for (size_t i = 0; i < Frame.assignment_count; ++i)
	{
		const VlChunkAssignment& A = Frame.assignments[i];
		if (!Slots.IsValidIndex(static_cast<int32>(A.chunk)))
		{
			continue;
		}
		const int32 ChunkIndex = static_cast<int32>(A.chunk);
		FChunkSlot& Slot = Slots[ChunkIndex];
		if (Slot.Body == 0)
		{
			DirtyCells.Add(Slot.Cell);
		}
		else if (TArray<int32>* Members = BodyChunks.Find(Slot.Body))
		{
			Members->RemoveSwap(ChunkIndex);
			DirtyBodies.Add(Slot.Body);
			if (Members->Num() == 0)
			{
				BodyChunks.Remove(Slot.Body);
				BodyPoses.Remove(Slot.Body);
			}
		}
		Slot.bRemoved = A.body == VL_BODY_REMOVED;
		Slot.Body = (A.body == VL_BODY_STANDING || A.body == VL_BODY_REMOVED) ? 0 : BodyKey(A.structure, A.body);
		Slot.Local = ToVector(A.local_pos);
		if (Slot.Body != 0)
		{
			BodyChunks.FindOrAdd(Slot.Body).Add(ChunkIndex);
			DirtyBodies.Add(Slot.Body);
		}
		else
		{
			DirtyCells.Add(Slot.Cell);
		}
	}

	// Poses of bodies that moved.
	for (size_t i = 0; i < Frame.body_pose_count; ++i)
	{
		const VlBodyPose& P = Frame.body_poses[i];
		const uint64 Key = BodyKey(P.structure, P.body);
		const FTransform Pose(ToQuat(P.quat), ToVector(P.pos));
		BodyPoses.Add(Key, Pose);
		if (!DirtyBodies.Contains(Key))
		{
			if (TObjectPtr<UProceduralMeshComponent>* Component = BodyComponents.Find(Key); Component && *Component)
			{
				(*Component)->SetWorldTransform(Pose);
				(*Component)->SetVisibility(true);
			}
		}
	}

	for (const int32 Cell : DirtyCells)
	{
		RebuildCell(Cell);
	}
	for (const uint64 Body : DirtyBodies)
	{
		RebuildBody(Body);
	}
	DirtyCells.Reset();
	DirtyBodies.Reset();
}

namespace
{
	int64 SectionVertices(const UProceduralMeshComponent* Mesh)
	{
		int64 N = 0;
		for (int32 s = 0; Mesh && s < Mesh->GetNumSections(); ++s)
		{
			if (const FProcMeshSection* Section = const_cast<UProceduralMeshComponent*>(Mesh)->GetProcMeshSection(s))
			{
				N += Section->ProcVertexBuffer.Num();
			}
		}
		return N;
	}
}

int64 AVibeCityDirector::DrawnCellVertices() const
{
	int64 N = 0;
	for (const TObjectPtr<UProceduralMeshComponent>& Cell : CellComponents)
	{
		N += SectionVertices(Cell);
	}
	// An imported cell draws its intact chunks' triangles as baked (VibeCity.Render.ImportedCity
	// holds each mesh's triangles to the cell's): count the corners they make.
	for (int32 Cell = 0; Cell < ImportedOpaque.Num(); ++Cell)
	{
		if (ImportedOpaque[Cell])
		{
			N += 3 * (CellTriangles(Cell, false) + (ImportedGlass.IsValidIndex(Cell) && ImportedGlass[Cell] ? CellTriangles(Cell, true) : 0));
		}
	}
	return N;
}

int64 AVibeCityDirector::DrawnBodyVertices() const
{
	int64 N = 0;
	for (const TPair<uint64, TObjectPtr<UProceduralMeshComponent>>& Pair : BodyComponents)
	{
		N += SectionVertices(Pair.Value);
	}
	return N;
}

int32 AVibeCityDirector::RemovedChunks() const
{
	int32 N = 0;
	for (const FChunkSlot& Slot : Slots)
	{
		N += Slot.bRemoved ? 1 : 0;
	}
	return N;
}

int64 AVibeCityDirector::ExpectedVertices() const
{
	UVibeNetSubsystem* NetSubsystem = Net();
	VlMeshView M = {};
	if (!NetSubsystem || !NetSubsystem->ChunkMeshes(M))
	{
		return -1;
	}
	int64 N = 0;
	for (int32 i = 0; i < Slots.Num() && static_cast<size_t>(i) < M.range_count; ++i)
	{
		N += Slots[i].bRemoved ? 0 : M.ranges[i].vertex_count;
	}
	return N;
}
