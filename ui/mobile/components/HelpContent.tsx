import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space } from '../../shared/theme';

const chestnutImage = require('../assets/help/chestnut-91-left.png');
const sawyerImage = require('../assets/help/sawyer-26-right.png');

export default function HelpContent() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>How Meridian geocodes an address</Text>
      <Text style={styles.subtitle}>
        A short guide to what happens when you look up, reverse-geocode, or batch-process addresses.
      </Text>

      <View style={styles.coverageNote}>
        <Text style={styles.coverageText}>
          <Text style={styles.bold}>Coverage: </Text>
          Maine and New Hampshire, by design. Meridian isn't trying to cover the whole country —
          it's built specifically for these two states. Addresses outside Maine and New Hampshire
          aren't supported yet.
        </Text>
      </View>

      <Text style={styles.heading}>Forward geocoding: address → coordinates</Text>
      <Text style={styles.paragraph}>
        Every street is stored as a series of segments. Each segment records an address range on its{' '}
        <Text style={styles.bold}>left</Text> side and a separate range on its{' '}
        <Text style={styles.bold}>right</Text> side — because the two sides of a street are usually
        numbered differently (one side odd, one side even).
      </Text>
      <Text style={styles.paragraph}>When you geocode an address:</Text>
      <Text style={styles.listItem}>1. Look up the street by name and ZIP code, and find every segment that could match.</Text>
      <Text style={styles.listItem}>
        2. Check the house number's parity — <Text style={styles.bold}>odd numbers are treated as the left side</Text>{' '}
        of the street, <Text style={styles.bold}>even numbers as the right side</Text> — and pick the
        segment whose range on that side actually contains the number.
      </Text>
      <Text style={styles.listItem}>
        3. Interpolate a point proportionally along that segment: if the range runs 1–99 and you asked
        for 91, the point sits about 91% of the way from the "1" end toward the "99" end.
      </Text>
      <Text style={styles.listItem}>
        4. Offset the point slightly off the street centerline, onto the correct side, so the pin
        lands on the building's side of the road rather than in the middle of the street.
      </Text>

      <Image source={chestnutImage} style={styles.image} resizeMode="contain" />
      <Text style={styles.caption}>
        Chestnut Rd runs from house number 1 to 99. 91 is odd, so it's placed on the left side of the
        street, about 91% of the way toward the 99 end — matching the marker near "end num: 99."
      </Text>

      <Image source={sawyerImage} style={styles.image} resizeMode="contain" />
      <Text style={styles.caption}>
        Sawyer Brook Rd runs from house number 2 to 98. 26 is even, so it's placed on the right side
        of the street, close to the "start num: 2" end — since 26 is near the low end of the range.
      </Text>

      <Text style={styles.heading}>Street aliases (a.k.a. names)</Text>
      <Text style={styles.paragraph}>
        Many streets go by more than one name — a numbered route that's also known by a local name,
        for example. Every known alias for a street is kept alongside its primary name, so a query
        using any alias resolves to the same segments and the same coordinates as the primary name
        would.
      </Text>

      <Text style={styles.heading}>Reverse geocoding: coordinates → address</Text>
      <Text style={styles.paragraph}>
        Reverse geocoding runs the same logic backwards: find the street segment closest to the
        coordinate you provide, work out which side of that segment's direction of travel the point
        falls on, and interpolate a house number from how far along the segment the point sits — then
        round that number to the correct parity (odd for the left side, even for the right).
      </Text>

      <Text style={styles.heading}>Batch geocoding</Text>
      <Text style={styles.paragraph}>
        Batch jobs process a plain-text file of addresses (one per line, no cap on count), running
        the same forward-geocoding logic on every line independently — one bad address doesn't stop
        the rest of the batch. Results can be downloaded as a ZIP. Note: quota is only checked and
        recorded for email delivery, not for a plain batch run or ZIP download.
      </Text>

      <Text style={styles.heading}>Plan &amp; quota</Text>
      <Text style={styles.paragraph}>
        Usage is tracked per account email against a monthly request tier. Quota resets on the 1st of
        each calendar month; an email-delivery request that would exceed the remaining quota is
        rejected up front, before any addresses are processed.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    padding: space[4],
  },
  title: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 26,
    color: colors.text,
    marginBottom: 4,
  },
  subtitle: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    opacity: 0.7,
    marginBottom: space[4],
  },
  coverageNote: {
    borderWidth: 1,
    borderColor: colors.divider,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: space[3],
    marginBottom: space[6],
  },
  coverageText: {
    fontFamily: 'Lora_400Regular',
    fontSize: 13,
    color: colors.text,
    lineHeight: 19,
  },
  heading: {
    fontFamily: 'CormorantGaramond_600SemiBold',
    fontSize: 20,
    color: colors.text,
    marginTop: space[4],
    marginBottom: space[2],
  },
  paragraph: {
    fontFamily: 'Lora_400Regular',
    fontSize: 14,
    color: colors.text,
    lineHeight: 21,
    marginBottom: space[2],
  },
  listItem: {
    fontFamily: 'Lora_400Regular',
    fontSize: 14,
    color: colors.text,
    lineHeight: 21,
    marginBottom: space[2],
    paddingLeft: space[2],
  },
  bold: {
    fontFamily: 'Lora_600SemiBold',
  },
  image: {
    width: '100%',
    height: 220,
    borderRadius: 4,
    borderWidth: 6,
    borderColor: colors.surface,
    marginTop: space[4],
    marginBottom: 4,
  },
  caption: {
    fontFamily: 'Lora_400Regular',
    fontSize: 12,
    color: colors.text,
    opacity: 0.65,
    marginBottom: space[2],
  },
});
