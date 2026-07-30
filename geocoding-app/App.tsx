import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, ScrollView, StyleSheet } from 'react-native';

import BatchGeocodeForm from './components/BatchGeocodeForm';
import GeocodeForm from './components/GeocodeForm';

export default function App() {
  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <GeocodeForm />
        <BatchGeocodeForm />
      </ScrollView>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  content: {
    paddingVertical: 24,
  },
});
