import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';

import GeocodeForm from './components/GeocodeForm';

export default function App() {
  return (
    <View style={styles.container}>
      <GeocodeForm />
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    justifyContent: 'center',
  },
});
