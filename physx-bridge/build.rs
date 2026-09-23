#[cfg(feature = "gpu")]
use std::{env, path::PathBuf};

// DEFAULT_PHYSX_ROOT, DEFAULT_PHYSX_DESTRUCTION_SDK and the platform-aware
// SDK lookup, shared with the destruction and server build scripts.
include!("physx_sdk_location.rs");

/// The native API revision this bridge is written against
/// (`PxDestructionScene.h`). The header states that consumers are rebuilt
/// together with the SDK; a silent bump would change struct layouts under our
/// device reads, so the build fails loudly instead.
#[cfg(feature = "native-destruction")]
const NATIVE_DESTRUCTION_SCENE_VERSIONS: [&str; 3] = [
    "#define PX_DESTRUCTION_SCENE_VERSION 15",
    "#define PX_DESTRUCTION_SCENE_VERSION 16",
    // v17 changes no layout: `internalCorrectionLimit` stops being a boolean
    // and becomes the number of corrected solves one tick may run.
    "#define PX_DESTRUCTION_SCENE_VERSION 17",
];

#[cfg(feature = "destruction")]
/// The production checkout is `blast-stress-solver-2`, and since the
/// structural-realism merge (perf/full-tick) it carries BOTH lines of solver
/// work: the GPU solve (node-space CGLS, delta upload, early exit) and the
/// structural rig (Young's modulus column scaling, fibre bending, crush). A
/// build that fails on a missing `elasticModulusPa` or `colScale` is compiling
/// against a stale Blast tree. Overridable by BLAST_ROOT either way, and it
/// must agree with `destruction/Cargo.toml`'s `blast-stress-solver` path.
const DEFAULT_BLAST_ROOT: &str = "/root/workspace/blast-stress-solver-2/blast";

#[cfg(feature = "gpu")]
fn main() {
    println!("cargo:rerun-if-env-changed=PHYSX_ROOT");
    #[cfg(feature = "destruction")]
    println!("cargo:rerun-if-env-changed=BLAST_ROOT");
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=src/physx_bridge.cc");
    println!("cargo:rerun-if-changed=src/destruction.cc");
    println!("cargo:rerun-if-changed=include/physx_bridge.h");
    println!("cargo:rerun-if-changed=include/destruction.h");

    println!("cargo:rerun-if-env-changed=PHYSX_DESTRUCTION_SDK");
    let root = physx_root_or_panic();
    let include = physx_include(&root);
    // The activity SDK has a different CPU/GPU ABI. Select the module from
    // the header we compile against, never from whichever .so happens to be
    // present first on the library search path.
    let scene_header = include.join("PxSceneDesc.h");
    println!("cargo:rerun-if-changed={}", scene_header.display());
    let gpu_library = if std::fs::read_to_string(&scene_header)
        .expect("cannot read PhysX scene descriptor header")
        .contains("#define PX_DIRECT_GPU_SLEEPING_VERSION")
    {
        "PhysXGpuActivity_64"
    } else {
        "PhysXGpu_64"
    };
    let lib = physx_lib_dir(&root).unwrap_or_else(|| {
        panic!(
            "PhysX libraries not found below PHYSX_ROOT={}; expected \
             bin/linux.x86_64/release/libPhysX_static_64.a (or lib/ in an install)",
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
        lib.join(shared_library(gpu_library)),
    ] {
        assert!(
            required.is_file(),
            "required PhysX artifact is missing: {}",
            required.display()
        );
        println!("cargo:rerun-if-changed={}", required.display());
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

    // PhysX exposes its GPU API on macOS only when built for CuMetal, the one
    // GPU backend there.
    if target_is_macos() {
        build.define("PX_CUMETAL", "1");
    }

    #[cfg(feature = "destruction")]
    {
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

        println!("cargo:rerun-if-changed={}", blast.join(
            "include/extensions/stressphysx/NvBlastExtStressPhysXContactWrench.h").display());

        // NvBlastExtStressSolver.cpp only reaches for the CUDA solver when this
        // is defined; without it the GPU path is compiled out and requesting
        // gpuStressSolver fails destructible creation outright.
        #[cfg(feature = "cuda-stress")]
        {
            build.define("NVBLAST_ENABLE_CUDA_STRESS", None);
            build.define("NVBLAST_ENABLE_DIRECT_GPU_CONTACT_DRAIN", None);
            build.include(blast.join("include/extensions/stressgpu"));
            for source in [
                "source/sdk/extensions/stressphysx/NvBlastExtStressPhysXDirectGpu.cpp",
                "source/sdk/extensions/stressphysx/NvBlastExtStressPhysXGpuActivity.cpp",
                "source/sdk/extensions/stressphysx/NvBlastExtStressPhysXGpuHostMirror.cpp",
            ] {
                let path = blast.join(source);
                println!("cargo:rerun-if-changed={}", path.display());
                build.file(path);
            }
            for header in [
                "include/extensions/stressphysx/NvBlastExtStressPhysXDirectGpu.h",
                "include/extensions/stressphysx/NvBlastExtStressPhysXContactScratch.h",
                "include/extensions/stressphysx/NvBlastExtStressPhysXGpuActivity.h",
                "include/extensions/stressphysx/NvBlastExtStressPhysXGpuHostMirror.h",
            ] {
                println!("cargo:rerun-if-changed={}", blast.join(header).display());
            }
            compile_cuda_stress(&blast, &include);
        }
    }

    #[cfg(feature = "native-destruction")]
    add_native_destruction(&mut build, &root, &include, &lib, gpu_library);

    add_vehicle(&mut build, &root);

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
    // PhysX also dlopens libPhysXGpu_64.so at CUDA-context creation, and a
    // dlopen ignores the link search path. Without an rpath the GPU scene fails
    // to construct and the bridge reports "no GPU" -- which reads as missing
    // hardware rather than a missing runtime path, and silently downgrades
    // every GPU test to a skip.
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
    println!("cargo:rustc-link-lib=dylib={gpu_library}");
    if target_is_macos() {
        // CuMetal implements the CUDA driver and runtime APIs in one library,
        // and the SDK package ships it next to the GPU module.
        assert!(
            lib.join("libcumetal.dylib").is_file(),
            "libcumetal.dylib missing from {}; install the PhysX SDK with \
             build-destruction-sdk.py --preset macos-cumetal --stage sdk --install",
            lib.display()
        );
        println!("cargo:rustc-link-lib=dylib=cumetal");
    } else {
        println!("cargo:rustc-link-lib=dylib=cuda");
        // The .cu uses both the runtime API and the driver API (cuCtxPushCurrent);
        // the native shim uses the driver API for its device reads.
        #[cfg(any(feature = "cuda-stress", feature = "native-destruction"))]
        if let Some(dir) = cuda_lib_dir() {
            println!("cargo:rustc-link-lib=dylib=cudart");
            println!("cargo:rustc-link-search=native={}", dir.display());
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dir.display());
        }
    }
    println!("cargo:rustc-link-lib=dylib=dl");
    println!("cargo:rustc-link-lib=dylib=pthread");
    if !target_is_macos() {
        println!("cargo:rustc-link-lib=dylib=rt");
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
}

/// The PhysX SDK this build compiles and links against.
///
/// The vehicle: physx-2's packaged `NativeVehicle` (a PhysX Vehicle SDK car)
/// and the vehicle snippets' base/direct-drive/PhysX-integration classes it
/// wraps, compiled straight into the bridge. The wrapper lives only in the
/// physx-2 checkout; the snippet classes are NVIDIA's and identical in every
/// PhysX 5 tree, taken from whichever tree owns `PHYSX_ROOT` when it has them.
#[cfg(feature = "gpu")]
fn add_vehicle(build: &mut cc::Build, root: &std::path::Path) {
    let sdk = physx_destruction_sdk();
    let vehicle = sdk.join("destruction/vehicle");
    let wrapper = vehicle.join("PxNativeVehicle.cpp");
    assert!(
        wrapper.is_file(),
        "the packaged vehicle is missing: {} (PHYSX_DESTRUCTION_SDK={})",
        wrapper.display(),
        sdk.display()
    );
    // An install prefix has no snippets; the source tree three levels up does.
    let snippets = [
        root.join("snippets"),
        root.join("../../../snippets"),
        sdk.join("physx/snippets"),
    ]
    .into_iter()
    .find(|dir| dir.join("snippetvehiclecommon/base/Base.cpp").is_file())
    .unwrap_or_else(|| panic!("no snippetvehiclecommon below {} or {}", root.display(), sdk.display()));
    println!("cargo:rerun-if-changed={}", wrapper.display());
    println!("cargo:rerun-if-changed={}", vehicle.join("PxNativeVehicle.h").display());
    build.file(&wrapper).include(&vehicle).include(&snippets);
    for source in [
        "snippetvehiclecommon/base/Base.cpp",
        "snippetvehiclecommon/directdrivetrain/DirectDrivetrain.cpp",
        "snippetvehiclecommon/physxintegration/PhysXIntegration.cpp",
    ] {
        let path = snippets.join(source);
        println!("cargo:rerun-if-changed={}", path.display());
        build.file(path);
    }
}

/// The SDK this build compiles and links against; see `physx_root` in
/// `physx_sdk_location.rs`.
#[cfg(feature = "gpu")]
fn physx_root_or_panic() -> PathBuf {
    physx_root(cfg!(feature = "native-destruction")).unwrap_or_else(|| {
        panic!(
            "no PhysX destruction SDK (PxDestructionScene.h and its libraries) below \
             PHYSX_DESTRUCTION_SDK={}; build it with tools/scripts/build-destruction-sdk.py \
             (on macOS: --preset macos-cumetal --stage sdk --install)",
            physx_destruction_sdk().display()
        )
    })
}

/// Compiles the native destruction shim and checks the SDK really provides the
/// stage it talks to.
///
/// The header check is a version gate, not decoration: the device views this
/// bridge reads are raw structs, so a header/runtime mismatch is a silent
/// misread rather than a link error.
#[cfg(feature = "native-destruction")]
fn add_native_destruction(
    build: &mut cc::Build,
    root: &std::path::Path,
    include: &std::path::Path,
    lib: &std::path::Path,
    gpu_library: &str,
) {
    let header = include.join("PxDestructionScene.h");
    let text = std::fs::read_to_string(&header)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", header.display()));
    // The shim is written against v15 through v17. They differ only by additions
    // it guards, and the device views it reads are raw structs, so an unknown
    // version is a silent misread rather than a link error -- hence a hard stop.
    let version = NATIVE_DESTRUCTION_SCENE_VERSIONS
        .iter()
        .position(|marker| text.contains(marker))
        .unwrap_or_else(|| {
            panic!(
                "{} is not a destruction API this bridge understands (expected one of {:?}); \
                 rebuild the SDK and this bridge together",
                header.display(),
                NATIVE_DESTRUCTION_SCENE_VERSIONS
            )
        });
    let version = 15 + version;
    build.define("VIBE_PHYSX_DESTRUCTION_SCENE_VERSION", version.to_string().as_str());
    println!("cargo:rustc-env=VIBE_PHYSX_DESTRUCTION_SCENE_VERSION={version}");
    // From v17 the stage loops its correction: configureStress takes any
    // internalCorrectionLimit and runs up to that many corrected solves per
    // tick. Older SDKs refuse anything above one, so the bridge clamps there.
    if version >= 17 {
        build.define("VIBE_PHYSX_CORRECTION_LOOP", None);
    }
    // Two physx-2 lines both call themselves v16 and mean different things by
    // it (reserved contact pairs on one, correction blockers on the other), so
    // optional fields are detected by name, never by number.
    for (field, define) in [
        ("reservedContactPairs", "VIBE_PHYSX_HAS_RESERVED_CONTACT_PAIRS"),
        ("correctionBlockers", "VIBE_PHYSX_HAS_CORRECTION_BLOCKERS"),
    ] {
        if text.contains(field) {
            build.define(define, None);
        }
    }
    assert_eq!(
        gpu_library, "PhysXGpuActivity_64",
        "native destruction needs the physx-2 GPU module; PHYSX_ROOT={} looks like \
         an upstream PhysX install",
        root.display()
    );
    let runtime = lib.join(shared_library("PhysXDestructionGpuRuntime_64"));
    assert!(
        runtime.is_file(),
        "native destruction runtime missing: {}",
        runtime.display()
    );
    assert_sdk_cuda_matches(root);
    println!("cargo:rerun-if-changed={}", header.display());
    println!("cargo:rerun-if-changed={}", runtime.display());
    println!("cargo:rerun-if-changed=src/native_destruction.cc");
    println!("cargo:rerun-if-changed=src/native_observation.cc");
    println!("cargo:rerun-if-changed=include/native_destruction.h");

    build
        .file("src/native_destruction.cc")
        .file("src/native_observation.cc")
        .define("VIBE_LAND_NATIVE_DESTRUCTION", None);
    // cuda.h for CUevent and the synchronous device reads of the committed view:
    // CuMetal's clean-room headers ship in the macOS SDK package.
    if target_is_macos() {
        build.include(root.join("include/cumetal"));
    } else if let Some(dir) = cuda_lib_dir().and_then(|d| d.parent().map(|r| r.join("include"))) {
        build.include(dir);
    }
    // The SDK's own record of which sources produced these libraries; surfaced
    // by the server so a deployment can say what it is actually running.
    println!(
        "cargo:rustc-env=VIBE_PHYSX_SDK_ROOT={}",
        root.display()
    );
    println!("cargo:rustc-env=VIBE_PHYSX_SDK_LIB_DIR={}", lib.display());
    println!(
        "cargo:rustc-env=VIBE_PHYSX_SDK_REVISION={}",
        sdk_revision(root).unwrap_or_else(|| "unrecorded".to_string())
    );
    assert_sdk_libraries_match_manifest(root, &lib);
}

/// Locate `<sdk>/out/sdk-artifacts.json` from the resolved SDK root, which is
/// either `<sdk>/physx` or `<sdk>/out/install`.
fn sdk_manifest(root: &std::path::Path) -> Option<std::path::PathBuf> {
    root.ancestors()
        .map(|dir| dir.join("out/sdk-artifacts.json"))
        .find(|candidate| candidate.is_file())
}

/// The source revision the installed SDK was built from.
///
/// Worth carrying all the way to `/healthz`. Artifacts in the SDK's library
/// directory are not immutable -- a bisect, an experiment or an interrupted
/// rebuild writes over them in place -- and the failure that produces is
/// invisible from every other reading. A deployment ran for hours on a
/// revision that cannot construct a GPU scene on this card, serving an
/// indestructible city at a healthy 60 Hz, and nothing anywhere said which
/// engine it had loaded.
fn sdk_revision(root: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(sdk_manifest(root)?).ok()?;
    let value = text
        .split("\"source_revision\"")
        .nth(1)?
        .split('"')
        .nth(1)?
        .to_string();
    Some(value)
}

/// Refuse to build against libraries the SDK manifest does not describe.
///
/// The manifest records a sha256 per library at install time, so a library
/// replaced afterwards -- by a second build tree, a partial install, a copy
/// from another experiment -- no longer matches it. Linking that mixture
/// produces a binary whose static half and GPU module came from different
/// sources, and the symptom is a segfault deep inside the GPU allocator while
/// creating a scene, with nothing to point at the cause.
///
/// Skipped, loudly, where sha256sum is unavailable: a missing checksum tool is
/// not a reason to fail a build, but it is a reason to say so.
fn assert_sdk_libraries_match_manifest(root: &std::path::Path, lib: &std::path::Path) {
    let Some(manifest) = sdk_manifest(root) else { return };
    let Ok(text) = std::fs::read_to_string(&manifest) else { return };
    let Some(libraries) = text.split("\"libraries\"").nth(1) else { return };
    let Some(block) = libraries.split('{').nth(1).and_then(|rest| rest.split('}').next()) else {
        return;
    };
    for entry in block.split(',') {
        let mut parts = entry.split('"').filter(|part| !part.trim().is_empty() && *part != ": ");
        let (Some(name), Some(want)) = (parts.next(), parts.next()) else { continue };
        if !name.starts_with("lib") {
            continue;
        }
        let path = lib.join(name);
        if !path.is_file() {
            continue;
        }
        // sha256sum on Linux; macOS ships the same digest as `shasum -a 256`.
        let output = std::process::Command::new("sha256sum")
            .arg(&path)
            .output()
            .or_else(|_| std::process::Command::new("shasum").args(["-a", "256"]).arg(&path).output());
        let Ok(output) = output else {
            println!("cargo:warning=sha256sum unavailable; SDK libraries not verified");
            return;
        };
        let got = String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string();
        assert_eq!(
            got,
            want,
            "{} does not match the SDK manifest that describes it ({}). Something \
             installed over this library without recording it; rebuild the SDK.",
            path.display(),
            manifest.display()
        );
    }
}

/// Fail the build when this crate's CUDA toolkit is not the one that produced
/// the linked SDK.
///
/// Not pedantry. The GPU module is built with a statically linked CUDA runtime
/// and the architecture it was qualified on; building this crate's own device
/// code against a different toolkit produces a binary that links cleanly and
/// then segfaults inside the module's heap allocator while creating a scene.
/// That failure looks like a driver or hardware problem and costs a day.
#[cfg(feature = "native-destruction")]
fn assert_sdk_cuda_matches(root: &std::path::Path) {
    // `<sdk>/out/sdk-artifacts.json` records the exact compilers; the SDK root
    // is either `<sdk>/physx` or `<sdk>/out/install`.
    let manifest = root
        .ancestors()
        .map(|dir| dir.join("out/sdk-artifacts.json"))
        .find(|candidate| candidate.is_file());
    let Some(manifest) = manifest else {
        // Nothing recorded: an install that was relocated without its manifest.
        return;
    };
    println!("cargo:rerun-if-changed={}", manifest.display());
    let text = std::fs::read_to_string(&manifest).unwrap_or_default();
    let Some(sdk_release) = text
        .split("release ")
        .nth(1)
        .and_then(|rest| rest.split(',').next())
        .map(|v| v.trim().to_string())
    else {
        return;
    };
    let nvcc = cuda_lib_dir()
        .and_then(|dir| dir.parent().map(|root| root.join("bin/nvcc")))
        .filter(|nvcc| nvcc.is_file());
    let Some(nvcc) = nvcc else { return };
    let ours = std::process::Command::new(&nvcc)
        .arg("--version")
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default();
    let ours_release = ours
        .split("release ")
        .nth(1)
        .and_then(|rest| rest.split(',').next())
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    assert_eq!(
        ours_release,
        sdk_release,
        "CUDA {ours_release} ({}) does not match the {sdk_release} toolkit that built \
         the destruction SDK ({}); set CUDA_HOME to that toolkit",
        nvcc.display(),
        manifest.display()
    );
}

/// Where libcudart lives, so the linker and loader can find it.
#[cfg(any(feature = "cuda-stress", feature = "native-destruction"))]
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

/// Compiles the stress solver and GPU contact decoder.
///
/// Kept in their own static library because these files must go through nvcc;
/// everything else stays on the host compiler.
#[cfg(feature = "cuda-stress")]
fn compile_cuda_stress(blast: &std::path::Path, physx_include: &std::path::Path) {
    let source = blast.join("source/sdk/extensions/stressgpu/NvBlastExtStressGpu.cu");
    assert!(
        source.is_file(),
        "cuda-stress feature enabled but the CUDA solver source is missing: {}",
        source.display()
    );

    // Everything nvcc reads has to be in the rerun set. It was not, so editing
    // only the CUDA solver left the previous object in place and the run
    // measured the old kernel -- which produced one confidently-wrong "0
    // islands skipped" result before anyone noticed the build had not happened.
    // The arch list belongs here too: changing it changes the emitted SASS.
    println!("cargo:rerun-if-env-changed=VIBE_CUDA_ARCH");
    println!("cargo:rerun-if-changed={}", source.display());
    let contacts =
        blast.join("source/sdk/extensions/stressphysx/NvBlastExtStressPhysXContactGpu.cu");
    println!("cargo:rerun-if-changed={}", contacts.display());
    for header in [
        "include/extensions/stressgpu/NvBlastExtStressGpu.h",
        "include/extensions/stress/NvBlastExtStressSolver.h",
        // The stress equation itself now lives in a header shared with the
        // host walk. Editing it changes the kernel, so it belongs here too.
        "include/extensions/stress/NvBlastExtStressFormula.h",
    ] {
        println!("cargo:rerun-if-changed={}", blast.join(header).display());
    }

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
        .define("NDEBUG", None)
        .file(source)
        .file(contacts)
        .include(physx_include)
        .include(blast.join("include"))
        .include(blast.join("include/globals"))
        .include(blast.join("include/lowlevel"))
        .include(blast.join("include/extensions/stress"))
        .include(blast.join("include/extensions/stressgpu"))
        .include(blast.join("include/extensions/stressphysx"))
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
