using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using UnrealBuildTool;

// vibe-land's shared Rust client core (client-core-ffi), linked as a static library.
//
// The library is built by scripts/unreal/build-core.sh, which this module runs on every build (cargo
// no-ops in well under a second when nothing changed). Set VIBE_CORE_PREBUILT=1 to skip that and use
// whatever build-core.sh last produced. The header comes straight from client-core-ffi/include, and
// the build fails if the library was built from a different header (vibe_client_core.stamp).
public class VibeClientCore : ModuleRules
{
	public VibeClientCore(ReadOnlyTargetRules Target) : base(Target)
	{
		Type = ModuleType.External;

		string RepoRoot = Path.GetFullPath(Path.Combine(ModuleDirectory, "..", "..", "..", "..", "..", "..", ".."));
		string HeaderDir = Path.Combine(RepoRoot, "client-core-ffi", "include");
		string Header = Path.Combine(HeaderDir, "vibe_client_core.h");
		if (!File.Exists(Header))
		{
			throw new BuildException("VibeClientCore: header not found at " + Header + " (is the plugin inside the vibe-land repo?)");
		}
		PublicIncludePaths.Add(HeaderDir);
		// vibe_client_core_build.h (the library's hash; see build-core.sh) forces a relink on change.
		PublicIncludePaths.Add(Path.Combine(ModuleDirectory, "include-gen"));

		string Platform;
		string Arch;
		string LibName;
		if (Target.Platform == UnrealTargetPlatform.Mac)
		{
			Platform = "Mac"; Arch = "arm64"; LibName = "libvibe_client_core.a";
		}
		else if (Target.Platform == UnrealTargetPlatform.Linux)
		{
			Platform = "Linux"; Arch = "x86_64"; LibName = "libvibe_client_core.a";
		}
		else if (Target.Platform == UnrealTargetPlatform.Win64)
		{
			Platform = "Win64"; Arch = "x64"; LibName = "vibe_client_core.lib";
		}
		else
		{
			throw new BuildException("VibeClientCore: unsupported platform " + Target.Platform);
		}

		if (Environment.GetEnvironmentVariable("VIBE_CORE_PREBUILT") != "1")
		{
			RunBuildCore(RepoRoot, Platform);
		}

		string LibDir = Path.Combine(ModuleDirectory, "lib", Platform, Arch);
		string LibPath = Path.Combine(LibDir, LibName);
		if (!File.Exists(LibPath))
		{
			throw new BuildException("VibeClientCore: " + LibPath + " missing; run scripts/unreal/build-core.sh");
		}
		CheckStamp(Path.Combine(LibDir, "vibe_client_core.stamp"), Header);

		PublicAdditionalLibraries.Add(LibPath);
		AddNativeLibs(Path.Combine(LibDir, "native-libs.txt"));
	}

	private static void RunBuildCore(string RepoRoot, string Platform)
	{
		string Script = Path.Combine(RepoRoot, "scripts", "unreal", "build-core.sh");
		ProcessStartInfo Info = new ProcessStartInfo("/bin/bash", "\"" + Script + "\" --platform " + Platform)
		{
			UseShellExecute = false,
			RedirectStandardOutput = true,
			RedirectStandardError = true,
			WorkingDirectory = RepoRoot,
		};
		using (Process Build = Process.Start(Info))
		{
			string Out = Build.StandardOutput.ReadToEnd();
			string Err = Build.StandardError.ReadToEnd();
			Build.WaitForExit();
			if (Build.ExitCode != 0)
			{
				throw new BuildException("VibeClientCore: build-core.sh failed (" + Build.ExitCode + ")\n" + Out + Err);
			}
			string Summary = Out.Split('\n').LastOrDefault(Line => Line.StartsWith("build-core:"));
			Console.WriteLine(Summary ?? "VibeClientCore: built");
		}
	}

	private static void CheckStamp(string StampPath, string Header)
	{
		if (!File.Exists(StampPath))
		{
			throw new BuildException("VibeClientCore: " + StampPath + " missing; run scripts/unreal/build-core.sh");
		}
		string Expected = File.ReadAllLines(StampPath)
			.Where(Line => Line.StartsWith("header_sha256="))
			.Select(Line => Line.Substring("header_sha256=".Length).Trim())
			.FirstOrDefault() ?? "";
		string Actual;
		using (SHA256 Sha = SHA256.Create())
		{
			Actual = BitConverter.ToString(Sha.ComputeHash(File.ReadAllBytes(Header))).Replace("-", "").ToLowerInvariant();
		}
		if (Expected != Actual)
		{
			throw new BuildException("VibeClientCore: library was built from a different header (stamp " + Expected + ", header " + Actual + "); run scripts/unreal/build-core.sh");
		}
	}

	private void AddNativeLibs(string NativeLibsPath)
	{
		if (!File.Exists(NativeLibsPath))
		{
			return;
		}
		string[] Tokens = File.ReadAllText(NativeLibsPath).Split(new[] { ' ', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries);
		for (int i = 0; i < Tokens.Length; i++)
		{
			string Token = Tokens[i];
			if (Token == "-framework" && i + 1 < Tokens.Length)
			{
				PublicFrameworks.Add(Tokens[++i]);
			}
			else if (Token.StartsWith("-l"))
			{
				string Name = Token.Substring(2);
				// libSystem (and its libc/libm aliases) is always linked on Apple platforms.
				if (Name != "System" && Name != "c" && Name != "m")
				{
					PublicSystemLibraries.Add(Name);
				}
			}
			else if (Token.EndsWith(".lib"))
			{
				PublicSystemLibraries.Add(Token);
			}
		}
	}
}
