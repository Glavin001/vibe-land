// The city's chunks as the client core's meshes: standing chunks merged per cell, each live dynamic
// body its own mesh. See AVibeCityDirector.

#include "VibeCityDirector.h"

#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "VibeCityGrass.h"

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

	// Standing chunks are merged per cell of this size (cm), as the web merges per 32 m render cell
	// (client/src/scene/cityChunkMesh.ts): a fracture rebuilds only the cells it touched.
	constexpr double CellSizeCm = 3200.0;
}

struct AVibeCityDirector::FSectionBuffers
{
	TArray<FVector> Vertices;
	TArray<int32> Triangles;
	TArray<FVector> Normals;
	TArray<FVector2D> UV0;
	TArray<FVector2D> UV1;
	TArray<FProcMeshTangent> Tangents;

	void Reset()
	{
		Vertices.Reset();
		Triangles.Reset();
		Normals.Reset();
		UV0.Reset();
		UV1.Reset();
		Tangents.Reset();
	}
};

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
	const VlMaterial* Catalog = nullptr;
	size_t CatalogCount = 0;
	vl_catalog(&Catalog, &CatalogCount);
	CatalogLayerMetal.SetNum(static_cast<int32>(CatalogCount));
	CatalogGlass.SetNum(static_cast<int32>(CatalogCount));
	CatalogUvScale.SetNum(static_cast<int32>(CatalogCount));
	for (size_t i = 0; i < CatalogCount; ++i)
	{
		CatalogUvScale[i] = bHdMaterial && Catalog[i].hd_metres_per_tile > 0.0f ? Catalog[i].metres_per_tile / Catalog[i].hd_metres_per_tile : 1.0f;
		CatalogLayerMetal[i] = FVector2D(FMath::Max(Catalog[i].layer, 0), Catalog[i].metalness);
		CatalogGlass[i] = (Catalog[i].flags & VL_MATERIAL_GLASS) != 0;
	}
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
		Slot.Rest = FTransform(ToQuat(Chunk.rest_quat), ToVector(Chunk.rest_pos));
		const FVector P = Slot.Rest.GetLocation();
		const FIntPoint Key(FMath::FloorToInt(P.X / CellSizeCm), FMath::FloorToInt(P.Y / CellSizeCm));
		int32* Existing = CellByKey.Find(Key);
		Slot.Cell = Existing ? *Existing : CellByKey.Add(Key, CellChunks.Num());
		if (!Existing)
		{
			CellChunks.AddDefaulted();
			CellComponents.Add(NewChunkComponent());
		}
		CellChunks[Slot.Cell].Add(Index);
		Bounds += P;
	}
	for (int32 Cell = 0; Cell < CellChunks.Num(); ++Cell)
	{
		RebuildCell(Cell);
	}
	bCityBuilt = true;
	// The web's meadow over the ground (?grass=off there; -VibeNoGrass here).
	if (!FParse::Param(FCommandLine::Get(), TEXT("VibeNoGrass")))
	{
		if (AVibeCityGrass* Grass = GetWorld()->SpawnActor<AVibeCityGrass>())
		{
			Grass->SetExclusions(NetSubsystem->GrassExclusions());
		}
	}
	UE_LOG(LogVibeLand, Display, TEXT("city built: %d chunks (%llu vertices) in %d cells, %.1f ms; bounds %s"),
		Chunks.Num(), static_cast<unsigned long long>(Meshes.vertex_count), CellChunks.Num(),
		(FPlatformTime::Seconds() - Started) * 1000.0, *Bounds.ToString());
	OnCityBuilt.Broadcast(Bounds);
}

void AVibeCityDirector::AppendChunk(int32 ChunkIndex, const FTransform& ToComponent, FSectionBuffers& Opaque, FSectionBuffers& Glass) const
{
	UVibeNetSubsystem* NetSubsystem = Net();
	VlMeshView M = {};
	if (!NetSubsystem || !NetSubsystem->ChunkMeshes(M) || static_cast<size_t>(ChunkIndex) >= M.range_count)
	{
		return;
	}
	const VlMeshRange& R = M.ranges[ChunkIndex];
	// One material per triangle (the core assigns it per face): route each triangle by its first
	// vertex's material.
	for (uint32 t = 0; t + 2 < R.index_count; t += 3)
	{
		const uint32 First = R.first_vertex + M.indices[R.first_index + t];
		const uint32 Material = M.materials[First];
		const bool bGlass = CatalogGlass.IsValidIndex(static_cast<int32>(Material)) && CatalogGlass[Material];
		FSectionBuffers& S = bGlass ? Glass : Opaque;
		const FVector2D LayerMetal = CatalogLayerMetal.IsValidIndex(static_cast<int32>(Material)) ? CatalogLayerMetal[Material] : FVector2D::ZeroVector;
		const double UvScale = CatalogUvScale.IsValidIndex(static_cast<int32>(Material)) ? CatalogUvScale[Material] : 1.0;
		for (uint32 k = 0; k < 3; ++k)
		{
			const uint32 V = R.first_vertex + M.indices[R.first_index + t + k];
			S.Triangles.Add(S.Vertices.Num());
			S.Vertices.Add(ToComponent.TransformPosition(ToVector(M.positions[V])));
			S.Normals.Add(ToComponent.TransformVectorNoScale(ToVector(M.normals[V])));
			const float(&Tg)[4] = M.tangents[V];
			// Unreal derives the binormal as normal x tangent, flipped when bFlipTangentY; the core's
			// w is +1 when normal x tangent already points along +v.
			S.Tangents.Add(FProcMeshTangent(ToComponent.TransformVectorNoScale(FVector(Tg[0], Tg[1], Tg[2])), Tg[3] < 0.0f));
			S.UV0.Add(FVector2D(M.tile_uvs[V][0], M.tile_uvs[V][1]) * UvScale);
			S.UV1.Add(LayerMetal);
		}
	}
}

void AVibeCityDirector::ApplySections(UProceduralMeshComponent* Component, FSectionBuffers& Opaque, FSectionBuffers& Glass) const
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
	FSectionBuffers Opaque, Glass;
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
	FSectionBuffers Opaque, Glass;
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
