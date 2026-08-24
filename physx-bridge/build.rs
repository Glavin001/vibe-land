#[cfg(feature = "gpu")]
use std::{env, path::PathBuf};

#[cfg(feature = "gpu")]
const DEFAULT_PHYSX_ROOT: &str = "/root/PhysX/physx/install/linux-clang/PhysX";

#[cfg(feature = "gpu")]
const DEFAULT_BLAST_ROOT: &str = "/root/workspace/blast-stress-solver/blast";

#[cfg(feature = "gpu")]
fn main() {
    println!("cargo:rerun-if-env-changed=PHYSX_ROOT");
    println!("cargo:rerun-if-env-changed=BLAST_ROOT");
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=src/physx_bridge.cc");
    println!("cargo:rerun-if-changed=src/destruction.cc");
    println!("cargo:rerun-if-changed=include/physx_bridge.h");
    println!("cargo:rerun-if-changed=include/destruction.h");

    let root =
        PathBuf::from(env::var_os("PHYSX_ROOT").unwrap_or_else(|| DEFAULT_PHYSX_ROOT.into()));
    let include = root.join("include");
    let lib = [root.join("bin/linux.x86_64/release"), root.join("lib")]
        .into_iter()
        .find(|candidate| candidate.join("libPhysX_static_64.a").is_file())
        .unwrap_or_else(|| {
            panic!(
                "PhysX libraries not found below PHYSX_ROOT={}; expected \
             bin/linux.x86_64/release/libPhysX_static_64.a",
                root.display()
            )
        });

    for required in [
        include.join("PxPhysicsAPI.h"),
        lib.join("libPhysX_static_64.a"),
        lib.join("libPhysXCommon_static_64.a"),
        lib.join("libPhysXFoundation_static_64.a"),
        lib.join("libPhysXExtensions_static_64.a"),
        lib.join("libPhysXCooking_static_64.a"),
        lib.join("libPhysXCharacterKinematic_static_64.a"),
        lib.join("libPhysXVehicle_static_64.a"),
        lib.join("libPhysXGpu_64.so"),
    ] {
        assert!(
            required.is_file(),
            "required PhysX artifact is missing: {}",
            required.display()
        );
    }

    let mut build = cxx_build::bridge("src/lib.rs");
    build
        .file("src/physx_bridge.cc")
        .include(&include)
        .include("include")
        .define("PX_PHYSX_STATIC_LIB", None)
        .flag_if_supported("-std=c++17")
        .flag_if_supported("-Wall")
        .flag_if_supported("-Wextra");

    if cfg!(feature = "destruction") {
        let blast =
            PathBuf::from(env::var_os("BLAST_ROOT").unwrap_or_else(|| DEFAULT_BLAST_ROOT.into()));
        let blast_sources = [
            "rust_stress_example/ffi/ext_stress_bridge.cpp",
            "source/shared/stress_solver/stress.cpp",
            "source/sdk/common/NvBlastAssert.cpp",
            "source/sdk/common/NvBlastAtomic.cpp",
            "source/sdk/common/NvBlastTime.cpp",
            "source/sdk/common/NvBlastTimers.cpp",
            "source/sdk/globals/NvBlastGlobals.cpp",
            "source/sdk/globals/NvBlastInternalProfiler.cpp",
            "source/sdk/lowlevel/NvBlastAsset.cpp",
            "source/sdk/lowlevel/NvBlastAssetHelper.cpp",
            "source/sdk/lowlevel/NvBlastFamily.cpp",
            "source/sdk/lowlevel/NvBlastFamilyGraph.cpp",
            "source/sdk/lowlevel/NvBlastActor.cpp",
            "source/sdk/lowlevel/NvBlastActorSerializationBlock.cpp",
            "source/sdk/extensions/stress/NvBlastExtStressSolver.cpp",
            "source/sdk/extensions/stressphysx/NvBlastExtStressPhysX.cpp",
            "source/sdk/extensions/stressphysx/NvBlastExtStressPhysXResim.cpp",
        ];
        for relative in blast_sources {
            let path = blast.join(relative);
            assert!(
                path.is_file(),
                "required Blast source missing under BLAST_ROOT={}: {}",
                blast.display(),
                path.display()
            );
            // Without this, editing a Blast source leaves the previous object
            // file in place and the next run silently exercises the old code.
            // That has already produced one confidently-wrong measurement.
            println!("cargo:rerun-if-changed={}", path.display());
            build.file(path);
        }
        build
            .file("src/destruction.cc")
            .define("VIBE_LAND_DESTRUCTION", None)
            .define("NDEBUG", None)
            .flag_if_supported("-mavx")
            .flag_if_supported("-mfma")
            .include(blast.join("include"))
            .include(blast.join("include/globals"))
            .include(blast.join("include/lowlevel"))
            .include(blast.join("include/extensions/stress"))
            .include(blast.join("include/extensions/stressphysx"))
            .include(blast.join("include/shared/NvFoundation"))
            .include(blast.join("source/shared"))
            .include(blast.join("source/shared/stress_solver"))
            .include(blast.join("source/sdk/common"))
            .include(blast.join("source/sdk/lowlevel"))
            .include(blast.join("source/shared/NsFoundation/include"))
            .include(blast.join("rust_stress_example/ffi"));

        // NvBlastExtStressSolver.cpp only reaches for the CUDA solver when this
        // is defined; without it the GPU path is compiled out and requesting
        // gpuStressSolver fails destructible creation outright.
        #[cfg(feature = "cuda-stress")]
        {
            build.define("NVBLAST_ENABLE_CUDA_STRESS", None);
            build.include(blast.join("include/extensions/stressgpu"));
            compile_cuda_stress(&blast);
        }
    }

    build.compile("vibe_land_physx_bridge");

    println!("cargo:rustc-link-search=native={}", lib.display());
    for library in [
        "PhysXExtensions_static_64",
        "PhysXCharacterKinematic_static_64",
        "PhysXVehicle_static_64",
        "PhysXCooking_static_64",
        "PhysX_static_64",
        "PhysXPvdSDK_static_64",
        "PhysXCommon_static_64",
        "PhysXFoundation_static_64",
    ] {
        println!("cargo:rustc-link-lib=static={library}");
    }
    println!("cargo:rustc-link-lib=dylib=PhysXGpu_64");
    println!("cargo:rustc-link-lib=dylib=cuda");
    // The .cu uses both the runtime API and the driver API (cuCtxPushCurrent).
    #[cfg(feature = "cuda-stress")]
    if let Some(dir) = cuda_lib_dir() {
        println!("cargo:rustc-link-lib=dylib=cudart");
        println!("cargo:rustc-link-search=native={}", dir.display());
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dir.display());
    }
    println!("cargo:rustc-link-lib=dylib=dl");
    println!("cargo:rustc-link-lib=dylib=pthread");
    println!("cargo:rustc-link-lib=dylib=rt");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
}

/// Where libcudart lives, so the linker and loader can find it.
#[cfg(feature = "cuda-stress")]
fn cuda_lib_dir() -> Option<PathBuf> {
    let root = env::var_os("CUDA_PATH")
        .or_else(|| env::var_os("CUDA_HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/local/cuda"));
    for candidate in ["lib64", "lib"] {
        let dir = root.join(candidate);
        if dir.is_dir() {
            return Some(dir);
        }
    }
    None
}

/// Compiles the one CUDA translation unit the Blast stress solver needs.
///
/// Kept as its own static library because it is the only file that must go
/// through nvcc; everything else stays on the host compiler.
#[cfg(feature = "cuda-stress")]
fn compile_cuda_stress(blast: &std::path::Path) {
    let source = blast.join("source/sdk/extensions/stressgpu/NvBlastExtStressGpu.cu");
    assert!(
        source.is_file(),
        "cuda-stress feature enabled but the CUDA solver source is missing: {}",
        source.display()
    );

    // Which GPUs the kernel is compiled for. The fleet rents whatever Vast has
    // capacity for, so this is a list, not a single card.
    let arch = env::var("VIBE_CUDA_ARCH").unwrap_or_else(|_| "sm_89".to_string());
    let gencode = gencode_flags(&arch);

    let mut cuda = cc::Build::new();
    if let Some(dir) = cuda_lib_dir() {
        if let Some(root) = dir.parent() {
            let nvcc = root.join("bin/nvcc");
            if nvcc.is_file() {
                cuda.compiler(nvcc);
            }
            cuda.include(root.join("include"));
        }
    }
    // cc-rs otherwise forwards host-compiler flags (-ffunction-sections and
    // friends) that nvcc rejects outright, so the flag set is given explicitly.
    cuda.cuda(true)
        .cpp(true)
        .no_default_flags(true)
        .warnings(false)
        .flag("-std=c++17")
        .flag("-O2")
        .flag("-m64")
        .flag("-Xcompiler")
        .flag("-fPIC")
        .define("NVBLAST_ENABLE_CUDA_STRESS", None)
        .file(source)
        .include(blast.join("include"))
        .include(blast.join("include/globals"))
        .include(blast.join("include/lowlevel"))
        .include(blast.join("include/extensions/stress"))
        .include(blast.join("include/extensions/stressgpu"))
        .include(blast.join("include/shared/NvFoundation"))
        .include(blast.join("source/shared"))
        .include(blast.join("source/shared/stress_solver"))
        .include(blast.join("source/sdk/common"));
    for flag in &gencode {
        cuda.flag(flag);
    }
    cuda.compile("vibe_land_blast_stress_gpu");
}

/// Turns `VIBE_CUDA_ARCH` into nvcc `-gencode` flags.
///
/// A single `-arch=sm_89` emits SASS for exactly one GPU generation, which is
/// wrong for a fleet whose hosts are whatever the marketplace had spare. Each
/// listed architecture gets its own cubin, and the highest one also gets a PTX
/// copy so a card newer than anything in the list JITs at load time instead of
/// failing to launch the stress kernel.
#[cfg(feature = "cuda-stress")]
fn gencode_flags(spec: &str) -> Vec<String> {
    let arches: Vec<&str> = spec
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    assert!(
        !arches.is_empty(),
        "VIBE_CUDA_ARCH is set but lists no architectures: {spec:?}"
    );

    let mut flags: Vec<String> = arches
        .iter()
        .map(|arch| {
            let num = arch.strip_prefix("sm_").unwrap_or_else(|| {
                panic!("VIBE_CUDA_ARCH entries must look like sm_89, got {arch:?}")
            });
            format!("-gencode=arch=compute_{num},code=sm_{num}")
        })
        .collect();

    // Sorted numerically, not lexically: sm_100 outranks sm_90.
    let highest = arches
        .iter()
        .map(|arch| {
            arch.trim_start_matches("sm_")
                .parse::<u32>()
                .unwrap_or_else(|_| panic!("unparseable CUDA arch {arch:?}"))
        })
        .max()
        .expect("checked non-empty above");
    flags.push(format!(
        "-gencode=arch=compute_{highest},code=compute_{highest}"
    ));
    flags
}

#[cfg(not(feature = "gpu"))]
fn main() {}
