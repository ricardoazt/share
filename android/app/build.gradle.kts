plugins {
  alias(libs.plugins.android.application)
}

android {
  namespace = "com.ricardo.pulseshare"
  compileSdk = 36

  defaultConfig {
    applicationId = "com.ricardo.pulseshare"
    minSdk = 24
    targetSdk = 36
    versionCode = 1
    versionName = "1.0.0"
  }

  signingConfigs {
    getByName("debug") {
      // Usar chave de debug padrão
    }
    create("release") {
      initWith(getByName("debug"))
    }
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      signingConfig = signingConfigs.getByName("release")
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
    debug {
      signingConfig = signingConfigs.getByName("debug")
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildFeatures {
    viewBinding = false
    buildConfig = false
    aidl = false
    shaders = false
  }

  packaging {
    resources {
      excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
  }
}

kotlin {
  jvmToolchain(17)
}

dependencies {
  // AndroidX Core & Lifecycle & Activity
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.ktx)
  implementation(libs.androidx.lifecycle.runtime.ktx)
}
