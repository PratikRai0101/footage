Pod::Spec.new do |s|
  s.name = 'FootageTransfer'
  s.version = '1.0.0'
  s.summary = 'Native original transfer owner for Footage'
  s.description = 'Durable foreground-only iOS original uploads with strict origin isolation.'
  s.license = { :type => 'MIT', :file => '../LICENSE' }
  s.author = 'Footage contributors'
  s.homepage = 'https://github.com/PratikRai0101/footage'
  s.source = { :git => 'https://github.com/PratikRai0101/footage.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CryptoKit', 'UIKit'
  s.source_files = '*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
