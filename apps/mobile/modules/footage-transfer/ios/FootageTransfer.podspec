Pod::Spec.new do |s|
  s.name = 'FootageTransfer'
  s.version = '0.1.0'
  s.summary = 'Native sealed background lifecycle owner; upload activation gated'
  s.description = s.summary
  s.license = { :type => 'MIT', :file => '../LICENSE' }
  s.author = 'Footage'
  s.homepage = 'https://github.com/PratikRai0101/footage'
  s.source = { :git => 'https://github.com/PratikRai0101/footage.git' }
  s.platform = :ios, '16.4'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Security', 'CryptoKit'
  s.libraries = 'sqlite3'
  s.swift_version = '6.0'
  s.source_files = '*.swift'
  config = {
    'DEFINES_MODULE' => 'YES'
    # Expo 58's prebuilt ObjC headers emit nullability/forward-protocol warnings.
    # Do not suppress them. The isolated combined native check uses warnings-as-errors.
  }
  # Test assembly is outside normal sources and has an additional compile-time guard.
  # This is a local test BUILD choice, never an installed app runtime switch.
  if ENV['FOOTAGE_EXPO_LIFECYCLE_TEST'] == '1'
    s.source_files = ['*.swift', 'build/lifecycle-test/Fixture.generated.swift']
    config = config.merge(
      'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => '$(inherited) FOOTAGE_EXPO_LIFECYCLE_TEST'
    )
  end
  s.pod_target_xcconfig = config
end
